import type {
  JobStore,
  LogStore,
  PackageCacheStore,
  SandboxLedgerStore,
  SnapshotRef,
} from '../../application/ports';
import { Job } from '../../domain/job/job';
import type { JobRecord, JobStatus, LogLine, LogStream } from '../../domain/job/record';
import type { SandboxLedgerEntry } from '../../domain/sandbox/ledger';

/**
 * The stores, in Durable Object SQLite.
 *
 * Jobs are short-lived, so this is enough — bodies with no size bound (the patch
 * and the result) go to R2 instead. Everything here is mechanical translation:
 * the rules about *when* to write live in the application layer, and this file
 * is where the SQL, its ceilings and its history are allowed to be visible.
 */

const MAX_LOG_LINES = 20_000;

/** Lines buffered before a write. Keeps storage calls off the hot output path. */
const LOG_FLUSH_SIZE = 64;

/**
 * Rows per insert statement.
 *
 * The ceiling is 100 bound parameters per query, and each row binds five
 * columns, so 20 rows is the maximum and 15 leaves headroom. Getting this wrong
 * is not subtle but it is quiet: the insert throws "too many SQL variables" and
 * the whole batch of log lines vanishes.
 */
const LOG_INSERT_CHUNK = 15;

/**
 * Create the tables, and carry the storage of earlier incarnations forward.
 *
 * Renaming a Durable Object class carries its storage over, so this object still
 * holds the tables from when it was TaskManager. The `logs` table there is keyed
 * by task_id, which CREATE TABLE IF NOT EXISTS silently leaves in place — every
 * insert then fails with "no such column: job_id". Logs are short-lived, so
 * rebuild rather than migrate, and drop the other legacy tables while we are here.
 */
export function migrate(sql: SqlStorage): void {
  const logColumns = sql
    .exec<{ name: string }>("SELECT name FROM pragma_table_info('logs')")
    .toArray()
    .map((row) => row.name);
  if (logColumns.includes('task_id')) sql.exec('DROP TABLE logs');

  sql.exec('DROP TABLE IF EXISTS tasks');
  sql.exec('DROP TABLE IF EXISTS artifacts');

  sql.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      status     TEXT NOT NULL,
      data       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS package_caches (
      key        TEXT PRIMARY KEY,
      ref        TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logs (
      job_id TEXT NOT NULL,
      seq    INTEGER NOT NULL,
      ts     INTEGER NOT NULL,
      stream TEXT NOT NULL,
      line   TEXT NOT NULL,
      PRIMARY KEY (job_id, seq)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Ledger of every sandbox this object has allocated. See domain/sandbox.
    CREATE TABLE IF NOT EXISTS sandboxes (
      id            TEXT PRIMARY KEY,
      job_id        TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      destroyed_at  INTEGER,
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT
    );
  `);
}

export class SqliteJobStore implements JobStore {
  constructor(private readonly sql: SqlStorage) {}

  load(id: string): Job | null {
    const row = this.sql
      .exec<{ data: string }>('SELECT data FROM jobs WHERE id = ?', id)
      .toArray()[0];
    return row ? Job.fromRecord(JSON.parse(row.data) as JobRecord) : null;
  }

  save(job: Job): void {
    const record = job.toRecord();
    this.sql.exec(
      `INSERT INTO jobs (id, created_at, status, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      record.id,
      record.createdAt,
      record.status,
      JSON.stringify(record)
    );
  }

  listRecent(limit: number): Job[] {
    return this.query(
      'SELECT data FROM jobs ORDER BY created_at DESC LIMIT ?',
      Math.min(Math.max(limit, 1), 100)
    );
  }

  listQueued(): Job[] {
    return this.query("SELECT data FROM jobs WHERE status = 'queued' ORDER BY created_at");
  }

  listByStatus(statuses: JobStatus[]): Job[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    return this.query(`SELECT data FROM jobs WHERE status IN (${placeholders})`, ...statuses);
  }

  countQueued(): number {
    return (
      this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'")
        .toArray()[0]?.n ?? 0
    );
  }

  idsCreatedBefore(cutoff: number): string[] {
    return this.sql
      .exec<{ id: string }>('SELECT id FROM jobs WHERE created_at < ?', cutoff)
      .toArray()
      .map((row) => row.id);
  }

  remove(id: string): void {
    this.sql.exec('DELETE FROM jobs WHERE id = ?', id);
  }

  private query(statement: string, ...bindings: unknown[]): Job[] {
    return this.sql
      .exec<{ data: string }>(statement, ...bindings)
      .toArray()
      .map((row) => Job.fromRecord(JSON.parse(row.data) as JobRecord));
  }
}

export class SqliteLogStore implements LogStore {
  private readonly pending = new Map<string, LogLine[]>();
  private readonly seq = new Map<string, number>();

  constructor(private readonly sql: SqlStorage) {}

  append(jobId: string, stream: LogStream, line: string): void {
    const next = (this.seq.get(jobId) ?? this.currentMaxSeq(jobId)) + 1;
    if (next > MAX_LOG_LINES) return;
    this.seq.set(jobId, next);

    const buffer = this.pending.get(jobId) ?? [];
    buffer.push({ seq: next, ts: Date.now(), stream, line: line.slice(0, 8000) });
    this.pending.set(jobId, buffer);

    if (buffer.length >= LOG_FLUSH_SIZE) this.flush(jobId);
  }

  /**
   * Write buffered lines.
   *
   * Chunked, because a single multi-row insert of everything buffered during
   * `npm install` overruns SQLite's bound-parameter ceiling and throws — which
   * silently ate most of a job's log. Values stay bound; only the placeholder
   * count is built into the statement. Lines leave the buffer only after their
   * chunk lands, so a failure loses nothing.
   */
  flush(jobId: string): void {
    const buffer = this.pending.get(jobId);
    if (!buffer || buffer.length === 0) return;

    while (buffer.length > 0) {
      const chunk = buffer.slice(0, LOG_INSERT_CHUNK);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const bindings = chunk.flatMap((line) => [jobId, line.seq, line.ts, line.stream, line.line]);

      this.sql.exec(
        `INSERT OR REPLACE INTO logs (job_id, seq, ts, stream, line) VALUES ${placeholders}`,
        ...bindings
      );
      buffer.splice(0, chunk.length);
    }

    this.pending.delete(jobId);
  }

  read(jobId: string, since: number, limit: number): LogLine[] {
    // Followers poll this; flush so buffered lines are visible immediately.
    this.flush(jobId);
    return this.sql
      .exec<LogLine>(
        'SELECT seq, ts, stream, line FROM logs WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        jobId,
        since,
        Math.min(Math.max(limit, 1), 5000)
      )
      .toArray();
  }

  removeFor(jobId: string): void {
    this.sql.exec('DELETE FROM logs WHERE job_id = ?', jobId);
    this.pending.delete(jobId);
    this.seq.delete(jobId);
  }

  private currentMaxSeq(jobId: string): number {
    const row = this.sql
      .exec<{ max_seq: number | null }>(
        'SELECT MAX(seq) AS max_seq FROM logs WHERE job_id = ?',
        jobId
      )
      .toArray()[0];
    return row?.max_seq ?? 0;
  }
}

export class SqliteLedgerStore implements SandboxLedgerStore {
  constructor(private readonly sql: SqlStorage) {}

  record(sandboxId: string, jobId: string, now: number): void {
    this.sql.exec(
      `INSERT INTO sandboxes (id, job_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, destroyed_at = NULL`,
      sandboxId,
      jobId,
      now
    );
  }

  countTeardownAttempt(sandboxId: string): void {
    this.sql.exec('UPDATE sandboxes SET attempts = attempts + 1 WHERE id = ?', sandboxId);
  }

  markDestroyed(sandboxId: string, now: number): void {
    this.sql.exec(
      'UPDATE sandboxes SET destroyed_at = ?, last_error = NULL WHERE id = ?',
      now,
      sandboxId
    );
  }

  markTeardownError(sandboxId: string, error: string): void {
    this.sql.exec('UPDATE sandboxes SET last_error = ? WHERE id = ?', error, sandboxId);
  }

  outstandingJobIds(): string[] {
    return this.sql
      .exec<{ job_id: string }>('SELECT job_id FROM sandboxes WHERE destroyed_at IS NULL')
      .toArray()
      .map((row) => row.job_id);
  }

  list(limit: number): SandboxLedgerEntry[] {
    return this.sql
      .exec<SandboxLedgerEntry>(
        `SELECT id, job_id AS jobId, created_at AS createdAt, destroyed_at AS destroyedAt,
                attempts, last_error AS lastError
         FROM sandboxes ORDER BY created_at DESC LIMIT ?`,
        Math.min(Math.max(limit, 1), 100)
      )
      .toArray();
  }
}

/**
 * The stored package cache per repository.
 *
 * One row, replaced. A cache is a single best-known copy — keeping every
 * generation would store the history of something whose only value is being
 * current, and the copies are megabytes each.
 */
export class SqlitePackageCacheStore implements PackageCacheStore {
  constructor(private readonly sql: SqlStorage) {}

  ref(key: string): SnapshotRef | null {
    const row = this.sql
      .exec<{ ref: string }>('SELECT ref FROM package_caches WHERE key = ?', key)
      .toArray()[0];
    return row ? (JSON.parse(row.ref) as SnapshotRef) : null;
  }

  save(key: string, ref: SnapshotRef, now: number): void {
    this.sql.exec(
      `INSERT INTO package_caches (key, ref, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET ref = excluded.ref, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(ref),
      now
    );
  }
}
