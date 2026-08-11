import { branchForJob, sanitizeRef } from './branch';
import { normalisePrompt } from './prompt';
import type { PullRequestRequest } from './pull-request';
import type {
  JobCommands,
  JobOptions,
  JobRecord,
  JobResult,
  JobSummary,
  JobUsage,
} from './record';
import { isTerminalStatus, type JobStatus } from './status';

export interface CreateJobInput {
  id: string;
  prompt: string;
  /** Already resolved against this deployment's policy — see `resolveRepository`. */
  repo: string;
  baseBranch: string;
  /** Work on this branch instead of the generated one. */
  branch?: string;
  options?: Partial<JobOptions>;
  /** Commands to run instead of the deployment's. Unspecified keys inherit. */
  commands?: Partial<JobCommands>;
  /** Open a pull request when the work lands. */
  pullRequest?: PullRequestRequest;
  now: number;
}

export interface SettleDetails {
  error?: string;
  result?: JobResult;
}

/**
 * A unit of work: run a prompt against a repository and produce a diff.
 *
 * The aggregate owns the transitions, and only the transitions. It has no idea
 * that sandboxes, containers, SQLite or HTTP exist — which is the point. Every
 * rule here was previously a condition inside a thousand-line polling loop,
 * where "a settled job cannot be settled again" was an `if` that had to be
 * remembered at four call sites.
 *
 * Mutable rather than persistent-immutable: callers load one, move it, and hand
 * it back to a store. That matches how the Durable Object works and keeps the
 * transitions readable.
 */
export class Job {
  private constructor(private readonly record: JobRecord) {}

  static create(input: CreateJobInput): Job {
    const prompt = normalisePrompt(input.prompt);
    const baseBranch = sanitizeRef(input.baseBranch);
    const branch = input.branch ? sanitizeRef(input.branch) : branchForJob(input.id);

    return new Job({
      id: input.id,
      status: 'queued',
      prompt,
      repo: input.repo,
      baseBranch,
      branch,
      createdAt: input.now,
      options: {
        skipChecks: input.options?.skipChecks === true,
        keepSandbox: input.options?.keepSandbox === true,
        push: input.options?.push === true,
      },
      commands: definedOnly(input.commands),
      ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
    });
  }

  /** Rehydrate from storage. Trusted: it was validated on the way in. */
  static fromRecord(record: JobRecord): Job {
    return new Job({ ...record });
  }

  toRecord(): JobRecord {
    return { ...this.record };
  }

  /** The projection a list renders: no step output, no raw agent stream. */
  toSummary(): JobSummary {
    const { result, ...rest } = this.record;
    if (!result) return { ...rest };
    return {
      ...rest,
      result: {
        changed: result.changed,
        commitSha: result.commitSha,
        branch: result.branch,
        pushed: result.pushed,
        diffStat: result.diffStat,
        diffBytes: result.diffBytes,
      },
    };
  }

  get id(): string {
    return this.record.id;
  }

  get status(): JobStatus {
    return this.record.status;
  }

  get repo(): string {
    return this.record.repo;
  }

  get branch(): string {
    return this.record.branch;
  }

  get baseBranch(): string {
    return this.record.baseBranch;
  }

  get options(): JobOptions {
    return this.record.options;
  }

  /** What this job runs instead of the deployment's commands. */
  get commandOverrides(): Partial<JobCommands> {
    return this.record.commands ?? {};
  }

  get isTerminal(): boolean {
    return isTerminalStatus(this.record.status);
  }

  get attempts(): number {
    return this.record.attempts ?? 0;
  }

  get logSeq(): number {
    return this.record.logSeq ?? 0;
  }

  get startedAt(): number | undefined {
    return this.record.startedAt;
  }

  get lastProgressAt(): number | undefined {
    return this.record.lastProgressAt;
  }

  get finishedAt(): number | undefined {
    return this.record.finishedAt;
  }

  /** Why it failed, already redacted by whoever settled it. */
  get error(): string | undefined {
    return this.record.error;
  }

  /** Allocating a sandbox and cloning. */
  start(now: number): void {
    this.record.status = 'starting';
    this.record.startedAt = now;
    // A restarted job must not resume mirroring from a stale offset.
    this.record.logSeq = 0;
  }

  /** The runner is up in the container. */
  markRunning(): void {
    this.record.status = 'running';
  }

  /**
   * Back to the queue as though it had never started.
   *
   * Used for the two situations where nothing has executed yet: a platform
   * interruption during launch, and a worker restart before the runner wrote
   * its first status. Both are safe precisely because the prompt has not run.
   */
  requeue(options: { attempts?: number } = {}): void {
    this.record.status = 'queued';
    this.record.startedAt = undefined;
    this.record.logSeq = 0;
    if (options.attempts !== undefined) this.record.attempts = options.attempts;
  }

  /** New output arrived. The log's own sequence number is the progress signal. */
  recordProgress(now: number, logSeq: number): void {
    this.record.logSeq = logSeq;
    this.record.lastProgressAt = now;
  }

  /** Recorded as it arrives, so a job that later fails still reports it. */
  recordUsage(usage: JobUsage): void {
    this.record.usage = usage;
  }

  recordFinalText(text: string): void {
    this.record.finalText = text;
  }

  /** The conversation a follow-up turn would resume. */
  get claudeSessionId(): string | undefined {
    return this.record.claudeSessionId;
  }

  recordClaudeSession(sessionId: string): void {
    this.record.claudeSessionId = sessionId;
  }

  markSandboxDestroyed(): void {
    this.record.sandboxDestroyed = true;
  }

  /** Whether this job asked for a pull request, and with what. */
  get pullRequestRequest(): PullRequestRequest | undefined {
    return this.record.pullRequest;
  }

  recordPullRequest(url: string): void {
    this.record.pullRequestUrl = url;
  }

  /**
   * Reach a terminal state. Returns false if the job was already in one.
   *
   * Several paths can arrive here at once — a cancellation racing a finished
   * runner, a poll racing the sweep — and the first outcome is the true one.
   */
  /**
   * The commands this job will actually run.
   *
   * The deployment's, with this job's overrides on top. An empty override wins
   * over a configured command, because empty means skip.
   */
  resolveCommands(configured: JobCommands): JobCommands {
    return { ...configured, ...this.commandOverrides };
  }

  settle(status: JobStatus, now: number, details: SettleDetails = {}): boolean {
    if (this.isTerminal) return false;
    this.record.status = status;
    this.record.finishedAt = now;
    if (details.error) this.record.error = details.error;
    if (details.result) this.record.result = details.result;
    return true;
  }
}

/**
 * Keep only the keys that were actually given a value.
 *
 * `{ lint: undefined }` is not an instruction to skip lint — it is a key the
 * caller happened to mention. Empty strings survive: those *are* an instruction.
 */
function definedOnly(commands: Partial<JobCommands> | undefined): Partial<JobCommands> {
  const given = Object.entries(commands ?? {}).filter(([, value]) => value !== undefined);
  return Object.fromEntries(given) as Partial<JobCommands>;
}
