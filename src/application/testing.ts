/**
 * In-memory implementations of every port.
 *
 * Only tests import this. It exists so a job's whole lifecycle — queued,
 * launched, mirrored, stalled, cancelled, settled, reclaimed — can be exercised
 * as arithmetic over Maps, at the speed of a unit test, instead of against a
 * container that takes a minute to start and cannot be made to fail on demand.
 */

import { Job } from '../domain/job/job';
import type { JobStatus, LogLine, LogStream } from '../domain/job/record';
import type { SandboxLedgerEntry } from '../domain/sandbox/ledger';
import type {
  ArtifactStore,
  Background,
  Clock,
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  GitHubAccess,
  JobIdFactory,
  JobStore,
  LogStore,
  OpenPullRequest,
  RunningJobs,
  SandboxLedgerStore,
  SandboxProvider,
  SandboxSession,
  Scheduler,
  SnapshotOptions,
  SessionState,
  SessionStore,
  SnapshotRef,
  UpdateSink,
} from './ports';

export class FakeClock implements Clock {
  constructor(private current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}

export class FakeIds implements JobIdFactory {
  private n = 0;
  next(): string {
    this.n += 1;
    return `job-${this.n}`;
  }
}

export class InMemoryJobStore implements JobStore {
  private readonly records = new Map<string, string>();

  load(id: string): Job | null {
    const raw = this.records.get(id);
    return raw ? Job.fromRecord(JSON.parse(raw)) : null;
  }

  save(job: Job): void {
    // Serialised on the way in, exactly as the real store does, so a test can
    // never accidentally share a mutable object with the code under test.
    this.records.set(job.id, JSON.stringify(job.toRecord()));
  }

  listRecent(limit: number): Job[] {
    return this.all()
      .sort((a, b) => b.toRecord().createdAt - a.toRecord().createdAt)
      .slice(0, limit);
  }

  listQueued(): Job[] {
    return this.all()
      .filter((job) => job.status === 'queued')
      .sort((a, b) => a.toRecord().createdAt - b.toRecord().createdAt);
  }

  listByStatus(statuses: JobStatus[]): Job[] {
    return this.all().filter((job) => statuses.includes(job.status));
  }

  countQueued(): number {
    return this.listQueued().length;
  }

  idsCreatedBefore(cutoff: number): string[] {
    return this.all()
      .filter((job) => job.toRecord().createdAt < cutoff)
      .map((job) => job.id);
  }

  remove(id: string): void {
    this.records.delete(id);
  }

  private all(): Job[] {
    return [...this.records.values()].map((raw) => Job.fromRecord(JSON.parse(raw)));
  }
}

export class InMemoryLogStore implements LogStore {
  private readonly lines = new Map<string, LogLine[]>();
  private readonly pending = new Map<string, LogLine[]>();
  private seq = new Map<string, number>();

  append(jobId: string, stream: LogStream, line: string): void {
    const next = (this.seq.get(jobId) ?? 0) + 1;
    this.seq.set(jobId, next);
    const buffer = this.pending.get(jobId) ?? [];
    buffer.push({ seq: next, ts: next, stream, line });
    this.pending.set(jobId, buffer);
  }

  flush(jobId: string): void {
    const buffer = this.pending.get(jobId);
    if (!buffer?.length) return;
    this.lines.set(jobId, [...(this.lines.get(jobId) ?? []), ...buffer]);
    this.pending.delete(jobId);
  }

  read(jobId: string, since: number, limit: number): LogLine[] {
    this.flush(jobId);
    return (this.lines.get(jobId) ?? []).filter((line) => line.seq > since).slice(0, limit);
  }

  removeFor(jobId: string): void {
    this.lines.delete(jobId);
    this.pending.delete(jobId);
    this.seq.delete(jobId);
  }

  /** Everything written so far, flushed or not — for assertions only. */
  all(jobId: string): string[] {
    return [...(this.lines.get(jobId) ?? []), ...(this.pending.get(jobId) ?? [])].map(
      (line) => line.line
    );
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  readonly patches = new Map<string, string>();
  readonly results = new Map<string, string>();

  async putPatch(jobId: string, patch: string): Promise<void> {
    this.patches.set(jobId, patch);
  }

  async putResult(jobId: string, body: string): Promise<void> {
    this.results.set(jobId, body);
  }

  async getPatch(jobId: string): Promise<string | null> {
    return this.patches.get(jobId) ?? null;
  }
}

export class InMemoryLedgerStore implements SandboxLedgerStore {
  private readonly entries = new Map<string, SandboxLedgerEntry>();

  record(sandboxId: string, jobId: string, now: number): void {
    this.entries.set(sandboxId, {
      id: sandboxId,
      jobId,
      createdAt: now,
      destroyedAt: null,
      attempts: 0,
      lastError: null,
    });
  }

  countTeardownAttempt(sandboxId: string): void {
    const entry = this.entries.get(sandboxId);
    if (entry) entry.attempts += 1;
  }

  markDestroyed(sandboxId: string, now: number): void {
    const entry = this.entries.get(sandboxId);
    if (entry) {
      entry.destroyedAt = now;
      entry.lastError = null;
    }
  }

  markTeardownError(sandboxId: string, error: string): void {
    const entry = this.entries.get(sandboxId);
    if (entry) entry.lastError = error;
  }

  outstandingJobIds(): string[] {
    return [...this.entries.values()].filter((e) => e.destroyedAt === null).map((e) => e.jobId);
  }

  list(limit: number): SandboxLedgerEntry[] {
    return [...this.entries.values()].slice(0, limit);
  }
}

export class RecordingScheduler implements Scheduler {
  readonly delays: number[] = [];
  async scheduleIn(delayMs: number): Promise<void> {
    this.delays.push(delayMs);
  }
}

export class InMemoryRunningJobs implements RunningJobs {
  private readonly jobs = new Map<string, { cancelled: boolean }>();

  get size(): number {
    return this.jobs.size;
  }
  ids(): string[] {
    return [...this.jobs.keys()];
  }
  has(jobId: string): boolean {
    return this.jobs.has(jobId);
  }
  begin(jobId: string): void {
    this.jobs.set(jobId, { cancelled: false });
  }
  end(jobId: string): void {
    this.jobs.delete(jobId);
  }
  requestCancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    entry.cancelled = true;
    return true;
  }
  isCancelled(jobId: string): boolean {
    return this.jobs.get(jobId)?.cancelled === true;
  }
}

export class AllowAllGitHub implements GitHubAccess {
  readonly checked: string[] = [];
  readonly checkedForWriting: string[] = [];
  readonly checkedForPullRequests: string[] = [];
  readonly opened: OpenPullRequest[] = [];
  /** Set to make opening fail, as a protected branch or a race would. */
  openError: string | null = null;

  async assertRepositoryReachable(repoUrl: string): Promise<void> {
    this.checked.push(repoUrl);
  }
  async assertRepositoryWritable(repoUrl: string): Promise<void> {
    this.checkedForWriting.push(repoUrl);
  }
  async assertCanOpenPullRequests(repoUrl: string): Promise<void> {
    this.checkedForPullRequests.push(repoUrl);
  }
  async openPullRequest(input: OpenPullRequest): Promise<string> {
    if (this.openError) throw new Error(this.openError);
    this.opened.push(input);
    return `https://github.com/o/r/pull/${this.opened.length}`;
  }
}

/** Reachable, but read-only — the posture a fresh GitHub App is set up with. */
export class ReadOnlyGitHub implements GitHubAccess {
  async assertRepositoryReachable(): Promise<void> {}
  async assertRepositoryWritable(): Promise<void> {
    throw new Error('the GitHub App installation cannot write to o/r; grant Contents: Read and write');
  }
  async assertCanOpenPullRequests(): Promise<void> {
    throw new Error('the GitHub App installation cannot open pull requests on o/r');
  }
  async openPullRequest(): Promise<string> {
    throw new Error('the GitHub App installation cannot open pull requests on o/r');
  }
}

export class DenyAllGitHub implements GitHubAccess {
  constructor(private readonly message = 'cannot reach that repository') {}
  async assertRepositoryReachable(): Promise<void> {
    throw new Error(this.message);
  }
  async assertRepositoryWritable(): Promise<void> {
    throw new Error(this.message);
  }
  async assertCanOpenPullRequests(): Promise<void> {
    throw new Error(this.message);
  }
  async openPullRequest(): Promise<string> {
    throw new Error(this.message);
  }
}

/**
 * One scripted `exec` call, consumed in order by `FakeSandbox.exec`.
 *
 * Lets a test play back an agent's stdout through `onOutput` the way a real
 * `claude` invocation would.
 */
export interface ExecScript {
  /** Lines delivered one at a time on the stdout stream via `onOutput`. */
  stdout?: string[];
  result?: ExecResult;
  /**
   * Never settle, as a still-running process would not. `killAll()` only
   * marks the sandbox killed; ending the turn is the caller's own abort race,
   * exactly as it would be against a real sandbox.
   */
  hang?: boolean;
}

/**
 * A sandbox whose filesystem is a Map and whose `exec` is scripted.
 *
 * The runner's state files are the contract between the container and the
 * executor (status.json, log.ndjson, result.json, patch.diff), so a test drives
 * a job by writing those the way a real runner would.
 */
export class FakeSandbox implements SandboxSession {
  readonly files = new Map<string, string>();
  readonly commands: string[] = [];
  destroyed = false;
  killed = false;
  cloned: { repo: string; branch?: string } | null = null;
  cloneCount = 0;
  /** Set to make the next clone fail, as a missing branch or lost access would. */
  cloneError: string | null = null;
  execError: string | null = null;
  private readonly execScripts: ExecScript[] = [];

  constructor(readonly id: string) {}

  /** Queue scripted `exec` calls, consumed one per call in order. */
  script(...scripts: ExecScript[]): void {
    this.execScripts.push(...scripts);
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command);
    if (this.execError) throw new Error(this.execError);

    // The one command the executor issues whose output it reads back.
    const tail = /tail -n \+(\d+) (\S+)/.exec(command);
    if (tail) {
      const from = Number.parseInt(tail[1] as string, 10);
      const body = this.files.get(tail[2] as string) ?? '';
      const lines = body.split('\n').filter(Boolean).slice(from - 1);
      return { success: true, exitCode: 0, stdout: lines.join('\n'), stderr: '' };
    }

    const script = this.execScripts.shift();
    if (!script) return { success: true, exitCode: 0, stdout: '', stderr: '' };

    for (const line of script.stdout ?? []) {
      options?.onOutput?.('stdout', line.endsWith('\n') ? line : `${line}\n`);
    }

    // Never settles: a real process that's still running doesn't hand back a
    // result just because it was asked to die. What ends the turn is the
    // caller's own abort race, exactly as it would against a real sandbox.
    if (script.hang) return new Promise<ExecResult>(() => {});

    return script.result ?? { success: true, exitCode: 0, stdout: '', stderr: '' };
  }

  async cloneRepository(repoUrl: string, options: { branch?: string }): Promise<void> {
    if (this.cloneError) throw new Error(this.cloneError);
    this.cloned = { repo: repoUrl, branch: options.branch };
    this.cloneCount += 1;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async killAll(): Promise<void> {
    this.killed = true;
  }

  /** Set to null to stand in for a deployment with no bucket bound. */
  snapshotRef: SnapshotRef | null = { provider: 'fake', id: 'snap-1' };
  snapshotted: SnapshotOptions[] = [];
  restored: SnapshotRef[] = [];
  restoreSucceeds = true;

  /** Set to make storing fail, the way missing R2 credentials do. */
  snapshotError: string | null = null;

  async snapshot(options: SnapshotOptions): Promise<SnapshotRef | null> {
    this.snapshotted.push(options);
    if (this.snapshotError) throw new Error(this.snapshotError);
    return this.snapshotRef;
  }
  async restore(ref: SnapshotRef): Promise<boolean> {
    this.restored.push(ref);
    return this.restoreSucceeds;
  }
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly name = 'fake';
  readonly sandboxes = new Map<string, FakeSandbox>();
  /** Set to make `create` throw, as a busy platform does. */
  createError: string | null = null;

  async create(sandboxId: string, _options?: CreateSandboxOptions): Promise<SandboxSession> {
    if (this.createError) throw new Error(this.createError);
    return this.get(sandboxId);
  }

  /** The sandbox with this id, created on demand — for arranging a test. */
  get(sandboxId: string): FakeSandbox {
    const existing = this.sandboxes.get(sandboxId);
    if (existing) return existing;
    const sandbox = new FakeSandbox(sandboxId);
    this.sandboxes.set(sandboxId, sandbox);
    return sandbox;
  }
}

export class InMemorySessionStore implements SessionStore {
  private state: SessionState = {};

  load(): SessionState {
    return { ...this.state };
  }

  save(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
  }

  clear(): void {
    this.state = {};
  }
}

export class RecordingUpdateSink implements UpdateSink {
  readonly messages: unknown[] = [];

  emit(message: unknown): void {
    this.messages.push(message);
  }
}

/**
 * Runs work right away and keeps a handle on it, so a test can await
 * `settle()` instead of racing real microtask timing to observe the result of
 * a `prompt()` call.
 */
export class ImmediateBackground implements Background {
  private readonly pending: Promise<void>[] = [];

  run(work: () => Promise<void>): void {
    this.pending.push(work());
  }

  /** Wait for everything scheduled so far to finish. */
  async settle(): Promise<void> {
    await Promise.all(this.pending.splice(0));
  }
}
