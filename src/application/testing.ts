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
  Clock,
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  GitHubAccess,
  JobIdFactory,
  JobStore,
  LogStore,
  RunningJobs,
  SandboxLedgerStore,
  SandboxProvider,
  SandboxSession,
  Scheduler,
  SnapshotRef,
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
  async assertRepositoryReachable(repoUrl: string): Promise<void> {
    this.checked.push(repoUrl);
  }
}

export class DenyAllGitHub implements GitHubAccess {
  constructor(private readonly message = 'cannot reach that repository') {}
  async assertRepositoryReachable(): Promise<void> {
    throw new Error(this.message);
  }
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
  /** Set to make the next clone fail, as a missing branch or lost access would. */
  cloneError: string | null = null;
  execError: string | null = null;

  constructor(readonly id: string) {}

  async exec(command: string, _options?: ExecOptions): Promise<ExecResult> {
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
    return { success: true, exitCode: 0, stdout: '', stderr: '' };
  }

  async cloneRepository(repoUrl: string, options: { branch?: string }): Promise<void> {
    if (this.cloneError) throw new Error(this.cloneError);
    this.cloned = { repo: repoUrl, branch: options.branch };
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

  async snapshot(): Promise<SnapshotRef | null> {
    return null;
  }
  async restore(): Promise<boolean> {
    return false;
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
