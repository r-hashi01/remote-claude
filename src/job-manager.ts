import { DurableObject } from 'cloudflare:workers';
import { loadConfig } from './config';
import { getSandboxProvider, type SandboxProvider, type SnapshotRef } from './providers';
import { createRedactor, type Redactor } from './redact';
import {
  describeUpdate,
  translateEvent,
  type AgentUsage,
  type ClaudeStreamEvent,
} from './acp';
import { RUNNER_SOURCE } from './runner-source';
import { MAX_PROMPT_LENGTH } from './shell';
import type { Env, JobRecord, JobRequest, JobResult, LogLine, SandboxLedger, SandboxLedgerEntry } from './types';

const MAX_LOG_LINES = 20_000;
/** Lines buffered before a write. Keeps storage calls off the hot output path. */
const LOG_FLUSH_SIZE = 64;
/**
 * Rows per insert statement.
 *
 * The ceiling is 100 bound parameters per query, and each row binds five
 * columns, so 20 rows is the maximum and 15 leaves headroom. Getting this
 * wrong is not subtle but it is quiet: the insert throws
 * "too many SQL variables" and the whole batch of log lines vanishes.
 */
const LOG_INSERT_CHUNK = 15;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How often to mirror a running job's state files into this object. */
const POLL_INTERVAL_MS = 2_000;
/** Where the container runner keeps its state files. Contract with runner.mjs. */
const STATE_DIR = '/workspace/.remote-claude';
const REPO_DIR = '/workspace/repo';
/**
 * How many times to retry a job that failed before its runner started.
 *
 * Only that window is retryable: nothing has been executed yet, so a retry has
 * no side effects. Once the runner is up, a retry would re-run the user's
 * prompt, which is not the same thing at all.
 */
const MAX_LAUNCH_ATTEMPTS = 3;

/**
 * How long without a heartbeat before the runner is presumed dead.
 *
 * The runner touches status.json every five seconds. Generous relative to that
 * so a slow poll or a busy container is not mistaken for a corpse, but far
 * short of the job timeout — which used to be the only thing that noticed, and
 * took thirty minutes to do it.
 */
const HEARTBEAT_TIMEOUT_MS = 90_000;

/**
 * How long without any new output before the job is presumed stuck.
 *
 * Liveness and progress are different questions: a runner looping forever
 * heartbeats perfectly happily. Progress needs no new signal — the log's own
 * sequence number already is one. This only became usable once Claude's output
 * was streamed rather than buffered until the step finished; before that a
 * working job and a stuck job looked identical for minutes.
 */
const STALL_TIMEOUT_MS = 8 * 60 * 1000;

/**
 * Errors that mean "the platform was busy", not "this job is broken".
 *
 * Observed twice in normal use: the sandbox runtime is updated underneath a
 * running operation and it is interrupted mid-flight.
 */
function isTransientPlatformError(message: string): boolean {
  return /updating the sandbox runtime|container unavailable|temporarily unavailable|503/i.test(
    message
  );
}
/**
 * Backstop interval for the orphan sweep.
 *
 * Short on purpose: orphans consume max_instances, so a leak blocks the queue
 * rather than merely costing money, and Durable Object alarms are cheap. The
 * primary reclaim path is not this timer anyway — it is the sweep on
 * construction, which runs at exactly the moment orphans are created.
 */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** Grace period before reclaiming a sandbox a caller asked to keep. */
const KEEP_GRACE_MS = 30 * 60 * 1000;

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
  private logSeq = new Map<string, number>();
  private pendingLogs = new Map<string, LogLine[]>();
  /** Jobs adopted from a previous incarnation, pending a liveness check. */
  private readonly recovered = new Set<string>();

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
        -- Ledger of every sandbox this object has allocated.
        --
        -- Exists because there was no way to answer "is what I allocated
        -- actually reclaimed?". The container platform's instance count turned
        -- out to report provisioned capacity, not running containers, so an
        -- external metric cannot answer it either. This object creates the
        -- sandboxes, so this object records them.
        CREATE TABLE IF NOT EXISTS sandboxes (
          id            TEXT PRIMARY KEY,
          job_id        TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          destroyed_at  INTEGER,
          attempts      INTEGER NOT NULL DEFAULT 0,
          last_error    TEXT
        );
      `);

      // Arm the backstop. The sweep itself runs below, after the job records
      // have been reconciled — an object is constructed right after the
      // eviction that orphaned those sandboxes, so this is the moment to
      // reclaim them, not five minutes later.
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);

      // Jobs in flight are NOT presumed dead any more.
      //
      // When the pipeline ran inside this object, an eviction really did kill
      // the work, so marking it failed was honest. Since the pipeline moved
      // into the container (ADR 0004) the runner survives a restart here, and
      // failing those jobs was throwing away work that was still going. Adopt
      // them instead; the first poll reads the container's own status and
      // decides whether the runner is alive or never started.
      for (const row of this.sql
        .exec<{ data: string }>("SELECT data FROM jobs WHERE status IN ('starting','running')")
        .toArray()) {
        const job = JSON.parse(row.data) as JobRecord;
        this.running.set(job.id, new AbortController());
        this.recovered.add(job.id);
      }

      // Deliberately not awaited inside blockConcurrencyWhile: reclaiming talks
      // to the container platform and can be slow, and nothing should be unable
      // to read a job list because a cleanup is in flight.
      this.ctx.waitUntil(this.sweepOrphans());
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
    // Return immediately. Starting a job clones the repository, which takes
    // tens of seconds — doing that inside this request blocked the caller and
    // risked the object being reset mid-clone. The alarm picks it up.
    await this.ctx.storage.setAlarm(Date.now());

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
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      this.persist(job);
      this.appendLog(id, 'system', 'job cancelled before it started');
      return job;
    }

    const controller = this.running.get(id);
    if (controller) {
      // The next poll observes this, kills the container processes and settles.
      controller.abort();
      this.appendLog(id, 'system', 'cancellation signal sent');
      return this.load(id);
    }

    return job; // already finished
  }

  // ----------------------------------------------------------- scheduling

  /**
   * Start queued jobs up to the concurrency limit.
   *
   * The queue is read from storage rather than held in memory: an object that
   * restarts would otherwise silently drop everything waiting.
   */
  private async drain(): Promise<void> {
    const config = loadConfig(this.env);

    const queued = this.sql
      .exec<{ data: string }>("SELECT data FROM jobs WHERE status = 'queued' ORDER BY created_at")
      .toArray()
      .map((row) => JSON.parse(row.data) as JobRecord);

    for (const job of queued) {
      if (this.running.size >= config.maxConcurrency) break;
      if (this.running.has(job.id)) continue;
      await this.launch(job);
    }
  }

  /**
   * Start a job.
   *
   * Returns as soon as the container runner is running. The pipeline itself
   * lives in the container (ADR 0004) — a Durable Object gets 30 seconds of CPU
   * between requests and is evicted past that, which capped jobs at roughly 51
   * seconds when the pipeline ran from here.
   */
  private async launch(job: JobRecord): Promise<void> {
    const config = loadConfig(this.env);
    const controller = new AbortController();
    this.running.set(job.id, controller);

    job.status = 'starting';
    job.startedAt = Date.now();
    job.logSeq = 0;
    this.persist(job);

    try {
      const sandboxId = `rc-${job.id}`;
      this.sql.exec(
        `INSERT INTO sandboxes (id, job_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, destroyed_at = NULL`,
        sandboxId,
        job.id,
        Date.now()
      );

      const sandbox = await getSandboxProvider(this.env).create(sandboxId, {
        sleepAfter: config.sleepAfter,
      });

      // Cloning stays on this side: it needs credentials injected outside the
      // container, which is the whole point of ADR 0002.
      this.appendLog(job.id, 'system', `cloning ${job.repo} (${job.baseBranch})`);
      await sandbox.cloneRepository(job.repo, { branch: job.baseBranch, targetDir: REPO_DIR });

      await sandbox.writeFile(
        `${STATE_DIR}/job.json`,
        JSON.stringify({
          id: job.id,
          prompt: job.prompt,
          branch: job.branch,
          baseBranch: job.baseBranch,
          options: job.options,
          commands: config.commands,
          stepTimeoutMs: config.jobTimeoutMs,
          claudeTimeoutMs: config.claudeTimeoutMs,
        })
      );

      // Ship the runner with the job rather than relying on the image. One
      // artifact, so no drift.
      await sandbox.writeFile(`${STATE_DIR}/runner.mjs`, RUNNER_SOURCE);

      // setsid + nohup so the runner outlives the shell this exec spawned.
      await sandbox.exec(
        `mkdir -p ${STATE_DIR} && setsid nohup node ${STATE_DIR}/runner.mjs ${STATE_DIR} ` +
          `> ${STATE_DIR}/runner.out 2>&1 < /dev/null &`,
        { cwd: '/workspace', env: containerEnvironment(this.env, config), timeoutMs: 30_000 }
      );

      job.status = 'running';
      this.persist(job);
      this.appendLog(job.id, 'system', 'runner started in container');
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    } catch (error) {
      const message = errorMessage(error);
      const attempts = (job.attempts ?? 0) + 1;

      // Safe to retry here and only here: the runner has not started, so
      // nothing has run and re-running has no side effects.
      if (isTransientPlatformError(message) && attempts < MAX_LAUNCH_ATTEMPTS) {
        this.running.delete(job.id);
        await this.teardown(job.id);

        const current = this.load(job.id) ?? job;
        current.status = 'queued';
        current.attempts = attempts;
        current.startedAt = undefined;
        this.persist(current);
        this.appendLog(
          job.id,
          'system',
          `platform interrupted the start (attempt ${attempts}/${MAX_LAUNCH_ATTEMPTS}); requeued: ${message}`
        );
        await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
        return;
      }

      await this.fail(job.id, message);
    }
  }

  /**
   * Read one running job's state files and mirror them into this object.
   *
   * Each alarm is a fresh invocation with a fresh CPU budget, which is what
   * makes an arbitrarily long job survivable.
   */
  private async pollJob(jobId: string): Promise<void> {
    const job = this.load(jobId);
    if (!job || isTerminal(job.status)) {
      this.running.delete(jobId);
      return;
    }

    const config = loadConfig(this.env);
    const controller = this.running.get(jobId);

    if (controller?.signal.aborted) {
      await this.stopContainer(jobId);
      await this.settle(jobId, 'cancelled', 'cancelled by request');
      return;
    }

    if (job.startedAt && Date.now() - job.startedAt > config.jobTimeoutMs) {
      await this.stopContainer(jobId);
      await this.settle(jobId, 'failed', `job exceeded ${config.jobTimeoutMs}ms`);
      return;
    }

    const sandbox = await getSandboxProvider(this.env).create(`rc-${jobId}`);

    // An adopted job may have been killed before its runner ever started.
    // status.json is written by the runner, so its absence answers that.
    if (this.recovered.delete(jobId)) {
      const alive = await sandbox.readFile(`${STATE_DIR}/status.json`);
      if (!alive) {
        this.appendLog(jobId, 'system', 'worker restarted before the runner started; requeued');
        this.running.delete(jobId);
        await this.teardown(jobId);
        const current = this.load(jobId);
        if (current) {
          current.status = 'queued';
          current.startedAt = undefined;
          current.logSeq = 0;
          this.persist(current);
        }
        return;
      }
      this.appendLog(jobId, 'system', 'resumed after worker restart; runner still running');
    }

    // Mirroring must never decide whether a job can finish. It used to run
    // before the status read with nothing catching it, so one failure in the
    // log path left the job polling until it hit its timeout — a job lost to a
    // problem with reporting on the job.
    await this.tryMirrorLogs(jobId, sandbox);

    const statusRaw = await sandbox.readFile(`${STATE_DIR}/status.json`);
    const status = statusRaw
      ? (JSON.parse(statusRaw) as { phase?: string; updatedAt?: number })
      : undefined;

    if (status?.phase === 'completed' || status?.phase === 'failed') {
      await this.finalize(jobId, sandbox, status.phase);
      return;
    }

    // Alive but producing nothing for a long time. Distinct from a dead
    // runner, and reported as such — "stuck" and "gone" want different responses
    // from whoever reads this.
    const progressed = job.lastProgressAt ?? job.startedAt ?? Date.now();
    if (Date.now() - progressed > STALL_TIMEOUT_MS) {
      await this.stopContainer(jobId);
      await this.settle(
        jobId,
        'failed',
        `no output for ${Math.round((Date.now() - progressed) / 60000)} minutes during ` +
          `"${status?.phase ?? 'startup'}"; presumed stuck`
      );
      return;
    }

    // Presume death rather than wait out the job timeout. Reported with the
    // phase it died in, which is the first thing anyone will want to know.
    const beat = status?.updatedAt ?? job.startedAt ?? Date.now();
    if (Date.now() - beat > HEARTBEAT_TIMEOUT_MS) {
      // The runner's own stdout/stderr is the only thing that can say why it
      // died. We were holding it the whole time and not reading it — knowing a
      // great deal about the runner's internals while failing to report the one
      // thing anyone needs.
      const output = (await sandbox.readFile(`${STATE_DIR}/runner.out`))?.trim();
      const detail = output ? `\nrunner output:\n${output.slice(-2000)}` : ' (runner produced no output)';

      await this.stopContainer(jobId);
      await this.settle(
        jobId,
        'failed',
        `runner stopped responding during "${status?.phase ?? 'startup'}" ` +
          `(no heartbeat for ${Math.round((Date.now() - beat) / 1000)}s).${detail}`
      );
    }
  }

  /** Mirror logs, surfacing any failure without letting it stall the job. */
  private async tryMirrorLogs(
    jobId: string,
    sandbox: Awaited<ReturnType<SandboxProvider['create']>>
  ): Promise<void> {
    try {
      await this.mirrorLogs(jobId, sandbox);
    } catch (error) {
      this.appendLog(jobId, 'system', `log mirroring failed: ${errorMessage(error)}`);
      // Persist immediately: a buffered report of a logging failure is a
      // report that disappears exactly when it is needed.
      this.flushLogs(jobId);
    }
  }

  /**
   * Copy log lines written since the last poll into this object.
   *
   * Line numbers and seq numbers align: the runner writes one line per seq.
   */
  private async mirrorLogs(
    jobId: string,
    sandbox: Awaited<ReturnType<SandboxProvider['create']>>
  ): Promise<void> {
    const job = this.load(jobId);
    if (!job) return;

    const since = (job.logSeq ?? 0) + 1;
    const tail = await sandbox.exec(`tail -n +${since} ${STATE_DIR}/log.ndjson 2>/dev/null || true`, {
      timeoutMs: 20_000,
    });

    let highest = job.logSeq ?? 0;
    for (const line of (tail.stdout ?? '').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { seq: number; stream: string; line: string };
        highest = Math.max(highest, entry.seq);

        if (entry.stream === 'agent') {
          // Raw agent events, interpreted here by the same translator the ACP
          // surface uses. The container emits facts; meaning is assigned once.
          const translated = translateEvent(JSON.parse(entry.line) as ClaudeStreamEvent);
          for (const update of translated.updates) {
            const rendered = describeUpdate(update);
            if (rendered) this.appendLog(jobId, 'stdout', rendered);
          }
          if (translated.usage) this.recordUsage(jobId, translated.usage);
          continue;
        }

        this.appendLog(jobId, entry.stream as LogLine['stream'], entry.line);
      } catch {
        // A partially written final line; it arrives complete next poll.
      }
    }

    // Flush within the poll rather than carrying a buffer across polls. The
    // buffer is in-memory, and between two-second alarms this object is idle
    // and may be evicted — anything still buffered would be lost, which is
    // exactly how the tail of a job's log kept disappearing. Batching still
    // pays off: one multi-row insert per poll instead of one per line.
    this.flushLogs(jobId);

    if (highest !== (job.logSeq ?? 0)) {
      const current = this.load(jobId);
      if (current) {
        current.logSeq = highest;
        // New output is the progress signal; nothing separate is needed.
        current.lastProgressAt = Date.now();
        this.persist(current);
      }
    }
  }

  /** Pull the runner's artifacts across and settle the job. */
  private async finalize(
    jobId: string,
    sandbox: Awaited<ReturnType<SandboxProvider['create']>>,
    phase: 'completed' | 'failed'
  ): Promise<void> {
    // Drain once more before settling. The runner can write its last lines
    // between the poll's tail and its status read, and losing the tail of a log
    // is exactly what previously made a failure look like it happened earlier
    // than it did.
    await this.tryMirrorLogs(jobId, sandbox);

    const redact = this.redactor();
    const resultRaw = await sandbox.readFile(`${STATE_DIR}/result.json`);
    const patchRaw = (await sandbox.readFile(`${STATE_DIR}/patch.diff`)) ?? '';

    // Second redaction layer. The container cannot do value-based redaction —
    // it does not hold the secrets (ADR 0002) — so it happens here.
    await this.env.ARTIFACTS.put(`jobs/${jobId}/patch.diff`, redact(patchRaw));

    let result: JobResult | undefined;
    let error: string | undefined;
    if (resultRaw) {
      const parsed = JSON.parse(redact(resultRaw)) as JobResult & { error?: string };
      if (parsed.error) error = parsed.error;
      else result = parsed;
      await this.env.ARTIFACTS.put(`jobs/${jobId}/result.json`, redact(resultRaw));
    }

    await this.settle(jobId, phase === 'completed' ? 'completed' : 'failed', error, result);
  }

  private async settle(
    jobId: string,
    status: JobRecord['status'],
    error?: string,
    result?: JobResult
  ): Promise<void> {
    const job = this.load(jobId);
    if (job && !isTerminal(job.status)) {
      job.status = status;
      job.finishedAt = Date.now();
      if (error) job.error = this.redactor()(error);
      if (result) job.result = result;
      this.persist(job);
      this.appendLog(jobId, 'system', `job ${status}${error ? `: ${job.error}` : ''}`);
    }

    this.flushLogs(jobId);
    this.running.delete(jobId);
    this.logSeq.delete(jobId);
    if (!job?.options.keepSandbox) await this.teardown(jobId);
    await this.drain();
  }

  private async fail(jobId: string, message: string): Promise<void> {
    await this.settle(jobId, 'failed', message);
  }

  private async stopContainer(jobId: string): Promise<void> {
    try {
      const sandbox = await getSandboxProvider(this.env).create(`rc-${jobId}`);
      await sandbox.killAll();
    } catch {
      // Nothing to stop.
    }
  }

  /** Consumption is recorded as it arrives, so it survives a failed job too. */
  private recordUsage(jobId: string, usage: AgentUsage): void {
    const job = this.load(jobId);
    if (!job) return;
    job.usage = usage;
    this.persist(job);
    this.appendLog(
      jobId,
      'system',
      `usage: ${usage.inputTokens} in / ${usage.outputTokens} out` +
        (usage.turns ? `, ${usage.turns} turns` : '')
    );
  }

  private redactor(): Redactor {
    return createRedactor([
      this.env.CLAUDE_CODE_OAUTH_TOKEN,
      this.env.GITHUB_APP_PRIVATE_KEY,
      this.env.REMOTE_CLAUDE_TOKEN,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    ]);
  }

  // ---------------------------------------------------- sandbox lifecycle

  /**
   * Destroy a job's sandbox and record the outcome. Never throws.
   *
   * Failures are recorded rather than swallowed: a sandbox that repeatedly
   * refuses to go away is exactly the thing the ledger exists to surface.
   */
  private async teardown(jobId: string): Promise<void> {
    const sandboxId = `rc-${jobId}`;
    this.sql.exec('UPDATE sandboxes SET attempts = attempts + 1 WHERE id = ?', sandboxId);

    try {
      const sandbox = await getSandboxProvider(this.env).create(sandboxId);
      await sandbox.destroy();
    } catch (error) {
      this.sql.exec(
        'UPDATE sandboxes SET last_error = ? WHERE id = ?',
        errorMessage(error).slice(0, 500),
        sandboxId
      );
      return;
    }

    this.sql.exec(
      'UPDATE sandboxes SET destroyed_at = ?, last_error = NULL WHERE id = ?',
      Date.now(),
      sandboxId
    );
    this.appendLog(jobId, 'system', 'sandbox destroyed');

    const job = this.load(jobId);
    if (job) {
      job.sandboxDestroyed = true;
      this.persist(job);
    }
  }

  /**
   * What this object has allocated and whether it got it back.
   *
   * `outstanding` is the number that matters: anything there is a sandbox we
   * created and have not confirmed destroyed.
   */
  async listSandboxes(): Promise<SandboxLedger> {
    const rows = this.sql
      .exec<SandboxLedgerEntry>(
        `SELECT id, job_id AS jobId, created_at AS createdAt, destroyed_at AS destroyedAt,
                attempts, last_error AS lastError
         FROM sandboxes ORDER BY created_at DESC LIMIT 100`
      )
      .toArray();

    return {
      outstanding: rows.filter((row) => row.destroyedAt === null),
      destroyed: rows.filter((row) => row.destroyedAt !== null).length,
      running: [...this.running.keys()],
      entries: rows,
    };
  }

  /**
   * Reclaim sandboxes whose job has finished but which were never torn down.
   *
   * Necessary because a Durable Object can be evicted mid-job, in which case
   * execute() never reaches its finally block. Observed in practice: four
   * failed jobs left three live containers, exactly filling max_instances and
   * blocking the queue.
   */
  private async sweepOrphans(): Promise<void> {
    const now = Date.now();
    const outstanding = this.sql
      .exec<{ job_id: string }>('SELECT job_id FROM sandboxes WHERE destroyed_at IS NULL')
      .toArray();

    for (const { job_id: jobId } of outstanding) {
      if (this.running.has(jobId)) continue;
      const job = this.load(jobId);
      if (!job || !isTerminal(job.status)) continue;

      // "Keep" means keep for inspection, not keep forever.
      const finished = job.finishedAt ?? job.createdAt;
      if (job.options.keepSandbox && now - finished < KEEP_GRACE_MS) continue;

      await this.teardown(jobId);
    }
  }

  /**
   * Drives everything periodic: mirroring running jobs, and reclaiming
   * sandboxes. Each firing is a fresh invocation with a fresh CPU budget, which
   * is what lets a job run arbitrarily long (ADR 0004).
   */
  async alarm(): Promise<void> {
    try {
      await this.drain();
      for (const jobId of [...this.running.keys()]) {
        try {
          await this.pollJob(jobId);
        } catch (error) {
          // One unhealthy job must not stop the others or the sweep.
          this.appendLog(jobId, 'system', `poll failed: ${errorMessage(error)}`);
        }
      }
      await this.sweepOrphans();
    } finally {
      // Poll fast while work is in flight or waiting, idle slowly otherwise.
      const pending = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'")
        .toArray()[0]?.n ?? 0;
      const next = this.running.size > 0 || pending > 0 ? POLL_INTERVAL_MS : SWEEP_INTERVAL_MS;
      await this.ctx.storage.setAlarm(Date.now() + next);
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

  /**
   * Write buffered lines.
   *
   * Chunked, because a single multi-row insert of everything buffered during
   * `npm install` overruns SQLite's bound-parameter ceiling and throws — which
   * silently ate most of a job's log. Values stay bound; only the placeholder
   * count is built into the statement.
   *
   * Lines are dropped from the buffer only after their chunk lands, so a
   * failure loses nothing.
   */
  private flushLogs(jobId: string): void {
    const pending = this.pendingLogs.get(jobId);
    if (!pending || pending.length === 0) return;

    while (pending.length > 0) {
      const chunk = pending.slice(0, LOG_INSERT_CHUNK);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const params = chunk.flatMap((entry) => [jobId, entry.seq, entry.ts, entry.stream, entry.line]);

      this.sql.exec(
        `INSERT OR REPLACE INTO logs (job_id, seq, ts, stream, line) VALUES ${placeholders}`,
        ...params
      );
      pending.splice(0, chunk.length);
    }

    this.pendingLogs.delete(jobId);
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

/**
 * Environment for the container runner.
 *
 * `undefined` unsets. The OAuth value is a sentinel in proxy mode — the real
 * token is swapped in by the Worker's outbound handler and never enters the
 * container (ADR 0002).
 */
function containerEnvironment(
  env: Env,
  config: ReturnType<typeof loadConfig>
): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN:
      config.claudeAuthMode === 'proxy' ? 'proxy-injected' : env.CLAUDE_CODE_OAUTH_TOKEN,
    IS_SANDBOX: '1',
    CI: '1',
  };
}

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
