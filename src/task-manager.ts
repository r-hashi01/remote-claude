import { DurableObject } from 'cloudflare:workers';
import { loadConfig } from './config';
import { createRedactor, type Redactor } from './redact';
import { MAX_PROMPT_LENGTH, runTask, TaskCancelledError } from './runner';
import type { Env, LogLine, TaskRecord, TaskRequest, TaskStatus } from './types';

/** Storage bound per task so a runaway job cannot fill the Durable Object. */
const MAX_LOG_LINES = 20_000;
const ARTIFACT_CHUNK = 64 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Single coordinator Durable Object.
 *
 * One object holds every task record, its logs and its artifacts, and owns the
 * concurrency gate. Using exactly one object is what makes the concurrency
 * counter trivially correct — there is no distributed state to reconcile.
 */
export class TaskManager extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** taskId → controller. Present only while a task is actually executing. */
  private readonly running = new Map<string, AbortController>();
  private queue: string[] = [];
  private logSeq = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id         TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          status     TEXT NOT NULL,
          data       TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS logs (
          task_id TEXT NOT NULL,
          seq     INTEGER NOT NULL,
          ts      INTEGER NOT NULL,
          stream  TEXT NOT NULL,
          line    TEXT NOT NULL,
          PRIMARY KEY (task_id, seq)
        );
        CREATE TABLE IF NOT EXISTS artifacts (
          task_id TEXT NOT NULL,
          name    TEXT NOT NULL,
          chunk   INTEGER NOT NULL,
          body    TEXT NOT NULL,
          PRIMARY KEY (task_id, name, chunk)
        );
      `);

      // A Durable Object can be evicted mid-flight (deploy, restart, crash).
      // Anything still marked in-flight at construction time did not survive,
      // so report that honestly instead of leaving it "running" forever.
      const stale = this.sql
        .exec<{ id: string; data: string }>(
          "SELECT id, data FROM tasks WHERE status IN ('queued','starting','running')"
        )
        .toArray();
      for (const row of stale) {
        const record = JSON.parse(row.data) as TaskRecord;
        record.status = 'failed';
        record.error = 'interrupted: the worker restarted while this task was in flight';
        record.finishedAt = Date.now();
        this.persist(record);
      }
    });
  }

  // ------------------------------------------------------------------
  // RPC surface
  // ------------------------------------------------------------------

  async createTask(request: TaskRequest): Promise<TaskRecord> {
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

    const baseBranch = sanitizeRef(request.baseBranch || config.defaultBaseBranch);
    const id = newTaskId();

    const record: TaskRecord = {
      id,
      status: 'queued',
      prompt,
      repo,
      baseBranch,
      branch: `claude/${id}`,
      createdAt: Date.now(),
      options: {
        skipChecks: request.skipChecks === true,
        keepSandbox: request.keepSandbox === true,
        push: request.push === true,
      },
    };

    this.pruneOldTasks();
    this.persist(record);
    this.queue.push(id);
    this.drain();

    return this.load(id) ?? record;
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    return this.load(id);
  }

  async listTasks(limit = 20): Promise<TaskRecord[]> {
    return this.sql
      .exec<{ data: string }>(
        'SELECT data FROM tasks ORDER BY created_at DESC LIMIT ?',
        Math.min(Math.max(limit, 1), 100)
      )
      .toArray()
      .map((row) => JSON.parse(row.data) as TaskRecord);
  }

  async getLogs(id: string, since = 0, limit = 2000): Promise<LogLine[]> {
    return this.sql
      .exec<LogLine>(
        'SELECT seq, ts, stream, line FROM logs WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        id,
        since,
        Math.min(Math.max(limit, 1), 5000)
      )
      .toArray();
  }

  async getArtifact(id: string, name: string): Promise<string | null> {
    const rows = this.sql
      .exec<{ body: string }>(
        'SELECT body FROM artifacts WHERE task_id = ? AND name = ? ORDER BY chunk',
        id,
        name
      )
      .toArray();
    if (rows.length === 0) return null;
    return rows.map((r) => r.body).join('');
  }

  async cancelTask(id: string): Promise<TaskRecord | null> {
    const record = this.load(id);
    if (!record) return null;

    if (record.status === 'queued') {
      this.queue = this.queue.filter((queued) => queued !== id);
      record.status = 'cancelled';
      record.finishedAt = Date.now();
      this.persist(record);
      this.appendLog(id, 'system', 'task cancelled before it started');
      this.drain();
      return record;
    }

    const controller = this.running.get(id);
    if (controller) {
      controller.abort();
      this.appendLog(id, 'system', 'cancellation signal sent');
      return this.load(id);
    }

    return record; // already finished
  }

  // ------------------------------------------------------------------
  // Scheduling
  // ------------------------------------------------------------------

  private drain(): void {
    const config = loadConfig(this.env);
    while (this.running.size < config.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const record = this.load(id);
      if (!record || record.status !== 'queued') continue;
      this.launch(record);
    }
  }

  private launch(record: TaskRecord): void {
    const config = loadConfig(this.env);
    const redact = createRedactor([
      this.env.CLAUDE_CODE_OAUTH_TOKEN,
      this.env.GITHUB_APP_PRIVATE_KEY,
      this.env.REMOTE_CLAUDE_TOKEN,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    ]);

    const controller = new AbortController();
    this.running.set(record.id, controller);

    const signal = anySignal([controller.signal, AbortSignal.timeout(config.taskTimeoutMs)]);

    record.status = 'starting';
    record.startedAt = Date.now();
    this.persist(record);

    const work = this.execute(record, signal, controller, redact);
    // Keeps the Durable Object alive for the duration of the task.
    this.ctx.waitUntil(work);
  }

  private async execute(
    record: TaskRecord,
    signal: AbortSignal,
    controller: AbortController,
    redact: Redactor
  ): Promise<void> {
    const config = loadConfig(this.env);

    try {
      const outcome = await runTask(record, {
        env: this.env,
        config,
        redact,
        signal,
        log: (stream, line) => this.appendLog(record.id, stream, line),
        setStatus: (status) => {
          const current = this.load(record.id);
          if (!current || isTerminal(current.status)) return;
          current.status = status;
          this.persist(current);
        },
      });

      this.storeArtifact(record.id, 'patch', outcome.patch);

      const final = this.load(record.id) ?? record;
      final.status = controller.signal.aborted ? 'cancelled' : 'completed';
      final.result = outcome.result;
      final.finishedAt = Date.now();
      this.persist(final);
      this.appendLog(record.id, 'system', `task ${final.status}`);
    } catch (error) {
      const final = this.load(record.id) ?? record;
      const cancelled = controller.signal.aborted || error instanceof TaskCancelledError;
      final.status = cancelled ? 'cancelled' : 'failed';
      final.error = redact(cancelled ? 'cancelled by request' : errorMessage(error));
      final.finishedAt = Date.now();
      this.persist(final);
      this.appendLog(record.id, 'system', `task ${final.status}: ${final.error}`);
    } finally {
      this.running.delete(record.id);
      this.logSeq.delete(record.id);
      this.drain();
    }
  }

  // ------------------------------------------------------------------
  // Storage helpers
  // ------------------------------------------------------------------

  private load(id: string): TaskRecord | null {
    const row = this.sql.exec<{ data: string }>('SELECT data FROM tasks WHERE id = ?', id).toArray()[0];
    return row ? (JSON.parse(row.data) as TaskRecord) : null;
  }

  private persist(record: TaskRecord): void {
    this.sql.exec(
      `INSERT INTO tasks (id, created_at, status, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      record.id,
      record.createdAt,
      record.status,
      JSON.stringify(record)
    );
  }

  private appendLog(taskId: string, stream: LogLine['stream'], line: string): void {
    const seq = (this.logSeq.get(taskId) ?? this.currentMaxSeq(taskId)) + 1;
    if (seq > MAX_LOG_LINES) return;
    this.logSeq.set(taskId, seq);
    this.sql.exec(
      'INSERT OR REPLACE INTO logs (task_id, seq, ts, stream, line) VALUES (?, ?, ?, ?, ?)',
      taskId,
      seq,
      Date.now(),
      stream,
      line.slice(0, 8000)
    );
  }

  private currentMaxSeq(taskId: string): number {
    const row = this.sql
      .exec<{ max_seq: number | null }>('SELECT MAX(seq) AS max_seq FROM logs WHERE task_id = ?', taskId)
      .toArray()[0];
    return row?.max_seq ?? 0;
  }

  private storeArtifact(taskId: string, name: string, body: string): void {
    this.sql.exec('DELETE FROM artifacts WHERE task_id = ? AND name = ?', taskId, name);
    for (let i = 0, chunk = 0; i < body.length; i += ARTIFACT_CHUNK, chunk += 1) {
      this.sql.exec(
        'INSERT INTO artifacts (task_id, name, chunk, body) VALUES (?, ?, ?, ?)',
        taskId,
        name,
        chunk,
        body.slice(i, i + ARTIFACT_CHUNK)
      );
    }
  }

  private pruneOldTasks(): void {
    const cutoff = Date.now() - RETENTION_MS;
    const doomed = this.sql
      .exec<{ id: string }>('SELECT id FROM tasks WHERE created_at < ?', cutoff)
      .toArray();
    for (const { id } of doomed) {
      if (this.running.has(id)) continue;
      this.sql.exec('DELETE FROM logs WHERE task_id = ?', id);
      this.sql.exec('DELETE FROM artifacts WHERE task_id = ?', id);
      this.sql.exec('DELETE FROM tasks WHERE id = ?', id);
    }
  }
}

// --------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function newTaskId(): string {
  const time = Date.now().toString(36);
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `${time}-${random}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
