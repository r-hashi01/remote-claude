import { DurableObject } from 'cloudflare:workers';
import { loadConfig } from './config';
import { getSandboxProvider, type SnapshotRef } from './providers';
import { createRedactor, type Redactor } from './redact';
import { MAX_PROMPT_LENGTH, runJob, JobCancelledError } from './runner';
import type { Env, JobRecord, JobRequest, JobResult, LogLine } from './types';

const MAX_LOG_LINES = 20_000;
/** Lines buffered before a write. Keeps storage calls off the hot output path. */
const LOG_FLUSH_SIZE = 64;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Execution coordinator.
 *
 * This object knows about *jobs* — run a prompt against a repository, return a
 * diff — and deliberately nothing about what the caller is using them for.
 * Projects, work items and their statuses belong to the product on the other
 * side of this API, not here.
 *
 * Exactly one instance exists, which is what makes the concurrency counter
 * trivially correct.
 *
 * State split:
 *   DO SQLite — job records and logs. Jobs are short-lived; this is enough.
 *   R2        — patch and result bodies, which have no size bound.
 */
export class JobManager extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** jobId → controller. Present only while a job is actually executing. */
  private readonly running = new Map<string, AbortController>();
  private queue: string[] = [];
  private logSeq = new Map<string, number>();
  private pendingLogs = new Map<string, LogLine[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      // Renaming a Durable Object class carries its storage over, so this
      // object still holds the tables from when it was TaskManager. The `logs`
      // table there is keyed by task_id, which CREATE TABLE IF NOT EXISTS
      // silently leaves in place — every insert then fails with
      // "no such column: job_id". Logs are short-lived, so rebuild rather than
      // migrate, and drop the other legacy tables while we are here.
      const logColumns = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('logs')")
        .toArray()
        .map((row) => row.name);
      if (logColumns.includes('task_id')) {
        this.sql.exec('DROP TABLE logs');
      }
      this.sql.exec('DROP TABLE IF EXISTS tasks');
      this.sql.exec('DROP TABLE IF EXISTS artifacts');

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id         TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          status     TEXT NOT NULL,
          data       TEXT NOT NULL
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
      `);

      // All execution funnels through this single object, so anything still
      // marked in flight at construction time did not survive the restart.
      for (const row of this.sql
        .exec<{ data: string }>("SELECT data FROM jobs WHERE status IN ('queued','starting','running')")
        .toArray()) {
        const job = JSON.parse(row.data) as JobRecord;
        job.status = 'failed';
        job.error = 'interrupted: the worker restarted while this job was in flight';
        job.finishedAt = Date.now();
        this.persist(job);
      }
    });
  }

  // ------------------------------------------------------------------ RPC

  async createJob(request: JobRequest): Promise<JobRecord> {
    const config = loadConfig(this.env);

    const prompt = (request.prompt ?? '').trim();
    if (!prompt) throw new Error('prompt is required');
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
    }

    let repo = config.repoUrl;
    if (request.repo && request.repo !== config.repoUrl) {
      if (!config.allowCustomRepo) {
        throw new Error('custom repositories are disabled (set ALLOW_CUSTOM_REPO=true to allow)');
      }
      repo = assertSafeRepoUrl(request.repo);
    }

    const id = newJobId();
    const job: JobRecord = {
      id,
      status: 'queued',
      prompt,
      repo,
      baseBranch: sanitizeRef(request.baseBranch || config.defaultBaseBranch),
      branch: request.branch ? sanitizeRef(request.branch) : `claude/${id}`,
      createdAt: Date.now(),
      options: {
        skipChecks: request.skipChecks === true,
        keepSandbox: request.keepSandbox === true,
        push: request.push === true,
      },
    };

    this.prune();
    this.persist(job);
    this.queue.push(id);
    void this.drain();

    return job;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return this.load(id);
  }

  async listJobs(limit = 20): Promise<JobRecord[]> {
    return this.sql
      .exec<{ data: string }>(
        'SELECT data FROM jobs ORDER BY created_at DESC LIMIT ?',
        Math.min(Math.max(limit, 1), 100)
      )
      .toArray()
      .map((row) => JSON.parse(row.data) as JobRecord);
  }

  async getLogs(id: string, since = 0, limit = 2000): Promise<LogLine[]> {
    // Followers poll this; flush so buffered lines are visible immediately.
    this.flushLogs(id);
    return this.sql
      .exec<LogLine>(
        'SELECT seq, ts, stream, line FROM logs WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        id,
        since,
        Math.min(Math.max(limit, 1), 5000)
      )
      .toArray();
  }

  async getPatch(id: string): Promise<string | null> {
    const object = await this.env.ARTIFACTS.get(`jobs/${id}/patch.diff`);
    return object ? object.text() : null;
  }

  async cancelJob(id: string): Promise<JobRecord | null> {
    const job = this.load(id);
    if (!job) return null;

    if (job.status === 'queued') {
      this.queue = this.queue.filter((queued) => queued !== id);
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      this.persist(job);
      this.appendLog(id, 'system', 'job cancelled before it started');
      void this.drain();
      return job;
    }

    const controller = this.running.get(id);
    if (controller) {
      controller.abort();
      this.appendLog(id, 'system', 'cancellation signal sent');
      return this.load(id);
    }

    return job; // already finished
  }

  // ----------------------------------------------------------- scheduling

  private async drain(): Promise<void> {
    const config = loadConfig(this.env);
    while (this.running.size < config.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const job = this.load(id);
      if (!job || job.status !== 'queued') continue;
      await this.launch(job);
    }
  }

  private async launch(job: JobRecord): Promise<void> {
    const config = loadConfig(this.env);
    const redact = createRedactor([
      this.env.CLAUDE_CODE_OAUTH_TOKEN,
      this.env.GITHUB_APP_PRIVATE_KEY,
      this.env.REMOTE_CLAUDE_TOKEN,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    ]);

    const controller = new AbortController();
    this.running.set(job.id, controller);
    const signal = anySignal([controller.signal, AbortSignal.timeout(config.jobTimeoutMs)]);

    job.status = 'starting';
    job.startedAt = Date.now();
    this.persist(job);

    this.ctx.waitUntil(this.execute(job, signal, controller, redact));
  }

  private async execute(
    job: JobRecord,
    signal: AbortSignal,
    controller: AbortController,
    redact: Redactor
  ): Promise<void> {
    const config = loadConfig(this.env);
    const sandbox = await getSandboxProvider(this.env).create(`rc-${job.id}`, {
      sleepAfter: config.sleepAfter,
    });

    try {
      const outcome = await runJob(job, {
        env: this.env,
        config,
        redact,
        signal,
        sandbox,
        loadSnapshotRef: () => this.readSnapshotRef(),
        saveSnapshotRef: (ref) => this.writeSnapshotRef(ref),
        log: (stream, line) => this.appendLog(job.id, stream, line),
        setStatus: (status) => {
          const current = this.load(job.id);
          if (!current || isTerminal(current.status)) return;
          current.status = status;
          this.persist(current);
        },
      });

      await this.env.ARTIFACTS.put(`jobs/${job.id}/patch.diff`, outcome.patch);
      await this.env.ARTIFACTS.put(`jobs/${job.id}/result.json`, JSON.stringify(outcome.result));

      const final = this.load(job.id) ?? job;
      final.status = controller.signal.aborted ? 'cancelled' : 'completed';
      final.result = outcome.result;
      final.finishedAt = Date.now();
      this.persist(final);
      this.appendLog(job.id, 'system', `job ${final.status}`);
    } catch (error) {
      const final = this.load(job.id) ?? job;
      const cancelled = controller.signal.aborted || error instanceof JobCancelledError;
      final.status = cancelled ? 'cancelled' : 'failed';
      final.error = redact(cancelled ? 'cancelled by request' : errorMessage(error));
      final.finishedAt = Date.now();
      this.persist(final);
      this.appendLog(job.id, 'system', `job ${final.status}: ${final.error}`);
    } finally {
      this.flushLogs(job.id);
      this.running.delete(job.id);
      this.logSeq.delete(job.id);
      await this.drain();
    }
  }

  // ------------------------------------------------------------- storage

  private load(id: string): JobRecord | null {
    const row = this.sql.exec<{ data: string }>('SELECT data FROM jobs WHERE id = ?', id).toArray()[0];
    return row ? (JSON.parse(row.data) as JobRecord) : null;
  }

  private persist(job: JobRecord): void {
    this.sql.exec(
      `INSERT INTO jobs (id, created_at, status, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      job.id,
      job.createdAt,
      job.status,
      JSON.stringify(job)
    );
  }

  private appendLog(jobId: string, stream: LogLine['stream'], line: string): void {
    const seq = (this.logSeq.get(jobId) ?? this.currentMaxSeq(jobId)) + 1;
    if (seq > MAX_LOG_LINES) return;
    this.logSeq.set(jobId, seq);

    const pending = this.pendingLogs.get(jobId) ?? [];
    pending.push({ seq, ts: Date.now(), stream, line: line.slice(0, 8000) });
    this.pendingLogs.set(jobId, pending);

    if (pending.length >= LOG_FLUSH_SIZE) this.flushLogs(jobId);
  }

  /** Write buffered lines as one multi-row insert. Values stay bound. */
  private flushLogs(jobId: string): void {
    const pending = this.pendingLogs.get(jobId);
    if (!pending || pending.length === 0) return;
    this.pendingLogs.delete(jobId);

    const placeholders = pending.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const params = pending.flatMap((entry) => [jobId, entry.seq, entry.ts, entry.stream, entry.line]);
    this.sql.exec(
      `INSERT OR REPLACE INTO logs (job_id, seq, ts, stream, line) VALUES ${placeholders}`,
      ...params
    );
  }

  private currentMaxSeq(jobId: string): number {
    const row = this.sql
      .exec<{ max_seq: number | null }>('SELECT MAX(seq) AS max_seq FROM logs WHERE job_id = ?', jobId)
      .toArray()[0];
    return row?.max_seq ?? 0;
  }

  private readSnapshotRef(): SnapshotRef | null {
    const raw = this.readMeta('workspaceSnapshot');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SnapshotRef;
    } catch {
      return null;
    }
  }

  private writeSnapshotRef(ref: SnapshotRef): void {
    this.writeMeta('workspaceSnapshot', JSON.stringify(ref));
  }

  private readMeta(key: string): string | null {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return row?.value ?? null;
  }

  private writeMeta(key: string, value: string): void {
    this.sql.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value
    );
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const { id } of this.sql
      .exec<{ id: string }>('SELECT id FROM jobs WHERE created_at < ?', cutoff)
      .toArray()) {
      if (this.running.has(id)) continue;
      this.sql.exec('DELETE FROM logs WHERE job_id = ?', id);
      this.sql.exec('DELETE FROM jobs WHERE id = ?', id);
    }
  }
}

// -------------------------------------------------------------- helpers

function isTerminal(status: JobRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function newJobId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `AbortSignal.any` with a manual fallback for older runtimes. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** Git refs are interpolated into shell commands — keep them boring. */
export function sanitizeRef(ref: string): string {
  const trimmed = ref.trim();
  if (!/^[A-Za-z0-9._\/-]{1,255}$/.test(trimmed) || trimmed.includes('..')) {
    throw new Error(`invalid branch name: ${trimmed}`);
  }
  return trimmed;
}

/** Only https GitHub URLs, and never one carrying inline credentials. */
export function assertSafeRepoUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('repo must be an absolute https URL');
  }
  if (url.protocol !== 'https:') throw new Error('repo must use https');
  if (url.username || url.password) throw new Error('repo URL must not embed credentials');
  if (url.hostname !== 'github.com') throw new Error('repo must be hosted on github.com');
  return url.toString();
}
