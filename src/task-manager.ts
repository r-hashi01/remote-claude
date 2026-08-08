import { DurableObject } from 'cloudflare:workers';
import { loadConfig } from './config';
import { getSandboxProvider, type SnapshotRef } from './providers';
import { createRedactor, type Redactor } from './redact';
import { MAX_PROMPT_LENGTH, runTask, TaskCancelledError } from './runner';
import { ensureDefaultProject } from './store/bootstrap';
import { createD1Store } from './store/d1';
import type { SpindleStore, Task, TaskStatus } from './store/types';
import type { Env, LogLine, TaskRecord, TaskRequest, TaskResult, TaskView } from './types';

/** Storage bound per task so a runaway job cannot fill the Durable Object. */
const MAX_LOG_LINES = 20_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Execution coordinator.
 *
 * Split of responsibility (docs/spindle-data-model-v0.1.md):
 *   D1  — durable domain state (tasks, sandbox runs, outputs)
 *   R2  — output bodies (patch, result JSON), which outgrow D1's 2 MB row cap
 *   DO  — live execution only: the concurrency gate, in-flight abort handles,
 *         and streaming logs
 *
 * Exactly one instance of this object exists, which is what makes the
 * concurrency counter trivially correct.
 */
export class TaskManager extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly store: SpindleStore;
  /** taskId → controller. Present only while a task is actually executing. */
  private readonly running = new Map<string, AbortController>();
  private queue: string[] = [];
  private logSeq = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.store = createD1Store(env.DB);

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          task_id TEXT NOT NULL,
          seq     INTEGER NOT NULL,
          ts      INTEGER NOT NULL,
          stream  TEXT NOT NULL,
          line    TEXT NOT NULL,
          PRIMARY KEY (task_id, seq)
        );
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      // A Durable Object can be evicted mid-flight (deploy, restart, crash).
      // All execution funnels through this single object, so anything still
      // marked in-flight did not survive. Report that rather than leaving a
      // task "in progress" forever.
      //
      // Guarded: this runs inside blockConcurrencyWhile, so a transient D1
      // failure here would otherwise prevent the object from ever starting
      // and take the entire task system down with it.
      try {
        await this.failInterruptedTasks();
      } catch {
        // Recovered on the next construction; not worth failing startup for.
      }
    });
  }

  // ------------------------------------------------------------------ RPC

  async createTask(request: TaskRequest): Promise<TaskView> {
    const config = loadConfig(this.env);

    const prompt = (request.prompt ?? '').trim();
    if (!prompt) throw new Error('prompt is required');
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
    }
    if (request.repo && request.repo !== config.repoUrl && !config.allowCustomRepo) {
      throw new Error('custom repositories are disabled (set ALLOW_CUSTOM_REPO=true to allow)');
    }

    const baseBranch = sanitizeRef(request.baseBranch || config.defaultBaseBranch);
    const { project, repository } = await ensureDefaultProject(this.store, config);

    const task = await this.store.tasks.create({
      projectId: project.id,
      repositoryId: repository.id,
      title: firstLine(prompt),
      intent: prompt,
      status: 'to_do',
      statusReason: 'queued for execution',
      baseBranch,
      originKind: 'manual',
    });

    // The branch is derived from the id, so it can only be set after insert.
    const withBranch = (await this.store.tasks.patch(task.id, {
      branch: `claude/${task.id}`,
    })) ?? task;

    await this.recordOptions(task.id, request);
    this.pruneOldLogs();
    this.queue.push(task.id);
    void this.drain();

    return this.toView(withBranch);
  }

  async getTask(taskId: string): Promise<TaskView | null> {
    const task = await this.store.tasks.get(taskId);
    return task ? this.toView(task) : null;
  }

  async listTasks(limit = 20): Promise<TaskView[]> {
    const tasks = await this.store.tasks.listRecent(Math.min(Math.max(limit, 1), 100));
    return Promise.all(tasks.map((task) => this.toView(task)));
  }

  async getLogs(taskId: string, since = 0, limit = 2000): Promise<LogLine[]> {
    return this.sql
      .exec<LogLine>(
        'SELECT seq, ts, stream, line FROM logs WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        taskId,
        since,
        Math.min(Math.max(limit, 1), 5000)
      )
      .toArray();
  }

  /** Unified diff, fetched from R2 via the recorded output. */
  async getPatch(taskId: string): Promise<string | null> {
    const outputs = await this.store.outputs.listByTask(taskId);
    const patch = outputs.find((output) => output.kind === 'patch');
    if (!patch?.storageKey) return null;
    const object = await this.env.ARTIFACTS.get(patch.storageKey);
    return object ? object.text() : null;
  }

  async cancelTask(taskId: string): Promise<TaskView | null> {
    const task = await this.store.tasks.get(taskId);
    if (!task) return null;

    const controller = this.running.get(taskId);
    if (controller) {
      controller.abort();
      this.appendLog(taskId, 'system', 'cancellation signal sent');
      return this.toView(task);
    }

    if (this.queue.includes(taskId)) {
      this.queue = this.queue.filter((queued) => queued !== taskId);
      // Cancelling returns the work to "not started" rather than marking it
      // failed: nothing went wrong, it simply has not been done.
      const updated = await this.setStatus(taskId, 'to_do', 'cancelled before it started');
      this.appendLog(taskId, 'system', 'task cancelled before it started');
      void this.drain();
      return updated ? this.toView(updated) : null;
    }

    return this.toView(task); // already settled
  }

  // ----------------------------------------------------------- scheduling

  private async drain(): Promise<void> {
    const config = loadConfig(this.env);
    while (this.running.size < config.maxConcurrency && this.queue.length > 0) {
      const taskId = this.queue.shift();
      if (!taskId) break;
      const task = await this.store.tasks.get(taskId);
      if (!task || task.status !== 'to_do') continue;
      await this.launch(task);
    }
  }

  private async launch(task: Task): Promise<void> {
    const config = loadConfig(this.env);
    const redact = createRedactor([
      this.env.CLAUDE_CODE_OAUTH_TOKEN,
      this.env.GITHUB_APP_PRIVATE_KEY,
      this.env.REMOTE_CLAUDE_TOKEN,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    ]);

    const controller = new AbortController();
    this.running.set(task.id, controller);
    const signal = anySignal([controller.signal, AbortSignal.timeout(config.taskTimeoutMs)]);

    await this.setStatus(task.id, 'in_progress', 'sandbox starting');

    const provider = getSandboxProvider(this.env);
    const run = await this.store.sandboxRuns.create({
      taskId: task.id,
      provider: provider.name,
      status: 'creating',
      executor: 'claude-code',
    });

    // Keeps the Durable Object alive for the duration of the task.
    this.ctx.waitUntil(this.execute(task, run.id, signal, controller, redact));
  }

  private async execute(
    task: Task,
    runId: string,
    signal: AbortSignal,
    controller: AbortController,
    redact: Redactor
  ): Promise<void> {
    const config = loadConfig(this.env);
    const options = this.readOptions(task.id);

    const sandbox = await getSandboxProvider(this.env).create(`rc-${task.id}`, {
      sleepAfter: config.sleepAfter,
    });
    await this.store.sandboxRuns.patch(runId, { status: 'running', startedAt: Date.now() });

    try {
      const outcome = await runTask(this.toRunnerRecord(task, config, options), {
        env: this.env,
        config,
        redact,
        signal,
        sandbox,
        loadSnapshotRef: () => this.readSnapshotRef(),
        saveSnapshotRef: (ref) => this.writeSnapshotRef(ref),
        log: (stream, line) => this.appendLog(task.id, stream, line),
        // The runner reports execution lifecycle; the work-status projection
        // is derived here, not taken verbatim.
        setStatus: () => {},
      });

      await this.persistOutcome(task, runId, outcome.result, outcome.patch);

      const cancelled = controller.signal.aborted;
      const [status, reason] = cancelled
        ? (['to_do', 'cancelled by request'] as const)
        : outcome.result.changed
          ? (['ready_for_review', 'changes ready to review'] as const)
          : (['done', 'completed with no file changes'] as const);

      await this.setStatus(task.id, status, reason);
      await this.store.sandboxRuns.patch(runId, {
        status: cancelled ? 'stopped' : 'destroyed',
        endedAt: Date.now(),
        headCommit: outcome.result.commitSha ?? null,
      });
      this.appendLog(task.id, 'system', `task ${status}`);
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof TaskCancelledError;
      const message = redact(cancelled ? 'cancelled by request' : errorMessage(error));

      await this.setStatus(task.id, cancelled ? 'to_do' : 'failed', message);
      await this.store.sandboxRuns.patch(runId, { status: 'failed', endedAt: Date.now() });
      this.appendLog(task.id, 'system', `task ${cancelled ? 'cancelled' : 'failed'}: ${message}`);
    } finally {
      this.running.delete(task.id);
      this.logSeq.delete(task.id);
      await this.drain();
    }
  }

  /** Patch and execution result become durable Outputs backed by R2. */
  private async persistOutcome(
    task: Task,
    runId: string,
    result: TaskResult,
    patch: string
  ): Promise<void> {
    if (patch.trim()) {
      const key = `tasks/${task.id}/patch.diff`;
      await this.env.ARTIFACTS.put(key, patch);
      await this.store.outputs.create({
        projectId: task.projectId,
        taskId: task.id,
        kind: 'patch',
        title: `Patch for ${task.title}`,
        status: result.changed ? 'ready' : 'empty',
        storageKey: key,
        producedBy: 'agent:claude-code',
        metadata: { diffStat: result.diffStat, commitSha: result.commitSha ?? null },
      });
    }

    const resultKey = `tasks/${task.id}/result.json`;
    await this.env.ARTIFACTS.put(resultKey, JSON.stringify(result));
    await this.store.sandboxRuns.patch(runId, { logKey: resultKey });

    const checks = result.steps.filter((step) => ['lint', 'test', 'build'].includes(step.name));
    if (checks.some((step) => !step.skipped)) {
      await this.store.outputs.create({
        projectId: task.projectId,
        taskId: task.id,
        kind: 'test_result',
        title: `Checks for ${task.title}`,
        status: checks.every((step) => step.success) ? 'passed' : 'failed',
        storageKey: resultKey,
        producedBy: 'agent:claude-code',
        metadata: { checks: checks.map((s) => ({ name: s.name, success: s.success, skipped: s.skipped })) },
      });
    }
  }

  // ------------------------------------------------------------ projection

  private async setStatus(
    taskId: string,
    status: TaskStatus,
    reason: string
  ): Promise<Task | null> {
    return this.store.tasks.patch(taskId, {
      status,
      statusReason: reason,
      ...(status === 'done' || status === 'failed' ? { closedAt: Date.now() } : {}),
    });
  }

  private async toView(task: Task): Promise<TaskView> {
    const settled = task.status !== 'in_progress' && !this.running.has(task.id) && !this.queue.includes(task.id);
    const view: TaskView = {
      id: task.id,
      title: task.title,
      prompt: task.intent ?? task.title,
      status: task.status,
      statusReason: task.statusReason,
      branch: task.branch,
      baseBranch: task.baseBranch,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      settled,
    };

    const object = await this.env.ARTIFACTS.get(`tasks/${task.id}/result.json`);
    if (object) view.result = JSON.parse(await object.text()) as TaskResult;
    return view;
  }

  private toRunnerRecord(task: Task, config: ReturnType<typeof loadConfig>, options: TaskRecord['options']): TaskRecord {
    return {
      id: task.id,
      status: 'running',
      prompt: task.intent ?? task.title,
      repo: config.repoUrl,
      baseBranch: task.baseBranch ?? config.defaultBaseBranch,
      branch: task.branch ?? `claude/${task.id}`,
      createdAt: task.createdAt,
      options,
    };
  }

  private async failInterruptedTasks(): Promise<void> {
    const stale = await this.store.tasks.listRecent(100);
    for (const task of stale) {
      if (task.status !== 'in_progress') continue;
      await this.store.tasks.patch(task.id, {
        status: 'failed',
        statusReason: 'interrupted: the worker restarted while this task was in flight',
        closedAt: Date.now(),
      });
    }
  }

  // --------------------------------------------------------- DO-local state

  /** Per-task execution options. Ephemeral: only meaningful while running. */
  private recordOptions(taskId: string, request: TaskRequest): void {
    this.writeMeta(
      `options:${taskId}`,
      JSON.stringify({
        skipChecks: request.skipChecks === true,
        keepSandbox: request.keepSandbox === true,
        push: request.push === true,
      })
    );
  }

  private readOptions(taskId: string): TaskRecord['options'] {
    const raw = this.readMeta(`options:${taskId}`);
    if (!raw) return { skipChecks: false, keepSandbox: false, push: false };
    try {
      return JSON.parse(raw) as TaskRecord['options'];
    } catch {
      return { skipChecks: false, keepSandbox: false, push: false };
    }
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

  /** Logs are DO-local and unbounded otherwise; domain state is pruned in D1. */
  private pruneOldLogs(): void {
    this.sql.exec('DELETE FROM logs WHERE ts < ?', Date.now() - RETENTION_MS);
  }
}

// -------------------------------------------------------------- helpers

function firstLine(text: string): string {
  return text.split('\n')[0].slice(0, 120);
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
