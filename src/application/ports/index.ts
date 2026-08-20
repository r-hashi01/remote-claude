import type { ClaudeAuthScheme } from '../../domain/agent/credential';
import type { Job } from '../../domain/job/job';
import type { JobCommands, JobStatus, LogLine, LogStream } from '../../domain/job/record';
import type { SandboxLedgerEntry } from '../../domain/sandbox/ledger';

/**
 * What the application layer needs from the outside world.
 *
 * Every one of these is implemented twice: once in `src/infrastructure` against
 * Durable Object storage, R2, GitHub and the container platform, and once in
 * `src/application/testing.ts` as something that lives in a Map. The use cases
 * cannot tell the difference, which is the entire reason a job's lifecycle can
 * now be tested without workerd, a container, or a network.
 *
 * The stores are synchronous because Durable Object SQLite is synchronous.
 * Pretending otherwise would add awaits that promise a concurrency this object
 * does not have.
 */

export * from './sandbox';
import type { SnapshotRef } from './sandbox';

export interface Clock {
  now(): number;
}

/** Generates job ids. A port because ids must be stable under test. */
export interface JobIdFactory {
  next(): string;
}

export interface JobStore {
  load(id: string): Job | null;
  save(job: Job): void;
  /** Newest first. */
  listRecent(limit: number): Job[];
  /** Oldest first — the queue is served in the order it was joined. */
  listQueued(): Job[];
  listByStatus(statuses: JobStatus[]): Job[];
  countQueued(): number;
  idsCreatedBefore(cutoff: number): string[];
  remove(id: string): void;
}

export interface LogStore {
  /** Buffered; `flush` is what makes a line visible to readers. */
  append(jobId: string, stream: LogStream, line: string): void;
  flush(jobId: string): void;
  read(jobId: string, since: number, limit: number): LogLine[];

  /**
   * Whether anything follows the cursor.
   *
   * A full page and a final page look identical, so a caller had to guess — and one
   * guessed wrong in a way that mattered: a job died at `install` with
   * `npm error ECONNRESET`, and the view showed a page ending in "lint ok" because
   * nothing said the cause was on the next one.
   */
  hasMore(jobId: string, since: number): boolean;

  /**
   * The last `limit` lines, in order.
   *
   * Because the end is where a failure explains itself, and walking to it a page at
   * a time is a loop a caller can abandon halfway — which is what happened.
   */
  readTail(jobId: string, limit: number): LogLine[];

  removeFor(jobId: string): void;
}

/** Patch and result bodies, which have no size bound. */
export interface ArtifactStore {
  putPatch(jobId: string, patch: string): Promise<void>;
  putResult(jobId: string, body: string): Promise<void>;
  getPatch(jobId: string): Promise<string | null>;
}

/**
 * Where the stored package cache for a repository is, if there is one.
 *
 * One row per repository, replaced rather than accumulated: a cache is a single
 * best-known copy, and keeping every generation of it would store the history of
 * something whose only value is being current.
 */
export interface PackageCacheStore {
  /** The stored cache for this key, or null when nothing has been kept yet. */
  ref(key: string): SnapshotRef | null;
  save(key: string, ref: SnapshotRef, now: number): void;
}

export interface SandboxLedgerStore {
  record(sandboxId: string, jobId: string, now: number): void;
  countTeardownAttempt(sandboxId: string): void;
  markDestroyed(sandboxId: string, now: number): void;
  markTeardownError(sandboxId: string, error: string): void;
  /** Job ids whose sandbox has not been confirmed destroyed. */
  outstandingJobIds(): string[];
  list(limit: number): SandboxLedgerEntry[];
}

/**
 * Whether the deployment's credential can actually reach a repository.
 *
 * A port rather than a list: the answer belongs to GitHub, and duplicating it
 * here would only ever be a stale subset of what the App installation permits.
 */
export interface OpenPullRequest {
  repo: string;
  /** The branch carrying the work. */
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface GitHubAccess {
  assertRepositoryReachable(repoUrl: string): Promise<void>;
  /**
   * Whether the credential may write to it.
   *
   * Asked for the same reason reachability is (ADR 0010): the answer belongs to
   * GitHub, and a job that will not be able to push should be refused before it
   * spends twenty minutes producing a branch it cannot deliver.
   */
  assertRepositoryWritable(repoUrl: string): Promise<void>;
  /** Refuse a pull request the credential could not open. */
  assertCanOpenPullRequests(repoUrl: string): Promise<void>;
  /** Returns the pull request's URL. */
  openPullRequest(input: OpenPullRequest): Promise<string>;
}

/** The Durable Object alarm, as far as the application is concerned. */
export interface Scheduler {
  scheduleIn(delayMs: number): Promise<void>;
}

/**
 * Jobs this executor is currently driving, and their cancellation.
 *
 * In production this is a Map of AbortControllers held by one Durable Object,
 * which is what makes the concurrency count trivially correct: exactly one
 * instance exists.
 */
export interface RunningJobs {
  readonly size: number;
  ids(): string[];
  has(jobId: string): boolean;
  begin(jobId: string): void;
  end(jobId: string): void;
  /** Signal a running job to stop. False if it was not running. */
  requestCancel(jobId: string): boolean;
  isCancelled(jobId: string): boolean;
}

/** Secret masking, as a function so the application never holds the secrets. */
export type Redact = (input: string) => string;

/** One session's persisted facts. The Durable Object's meta table implements this. */
export interface SessionState {
  claudeSessionId?: string;
  prepared?: boolean;
  repo?: string;
  baseBranch?: string;
}
export interface SessionStore {
  load(): SessionState;
  /** Merge — only the keys present in the patch are updated. */
  save(state: Partial<SessionState>): void;
  clear(): void;
}

/** Where a session update goes. The Durable Object persists it to SQLite and fans it out over SSE. */
export interface UpdateSink {
  emit(message: unknown): void;
}

/** Run outside the caller's request. The Durable Object implements this with ctx.waitUntil. */
export interface Background {
  run(work: () => Promise<void>): void;
}

/**
 * The deployment's settings, as the application needs them.
 *
 * Declared here rather than imported from the infrastructure's config loader:
 * the use cases define what they require, and the environment supplies it.
 */
export interface ExecutorPolicy {
  repoUrl: string;
  defaultBaseBranch: string;
  allowCustomRepo: boolean;
  /** Whether a job may push its branch. */
  allowPush: boolean;
  maxConcurrency: number;
  jobTimeoutMs: number;
  claudeTimeoutMs: number;
  heartbeatTimeoutMs: number;
  stallTimeoutMs: number;
  /** How long a job's record and logs are kept. */
  retentionMs: number;
  sleepAfter: string;
  /**
   * How much history to clone. Zero or absent means all of it.
   *
   * One, by default. The platform clones with `partialclonefilter=blob:none`, which
   * turns a checkout into a long stream of per-object fetches rather than one
   * transfer — and every failure observed so far has landed inside `git.checkout`,
   * which is the operation with the widest window to be interrupted in. Fewer
   * objects, narrower window.
   *
   * The cost is history: an agent that runs `git log` sees one commit, and jobs have
   * done that. Settable, so a deployment that needs the history can have it back
   * without a code change.
   */
  cloneDepth: number;
  /** The deployment's defaults. A job may override them per key. */
  commands: JobCommands;
  /**
   * Which credential this deployment holds — not the credential itself.
   *
   * Here rather than only in the infrastructure's config, unlike the auth
   * *mode*, because the command line these use cases build depends on it: which
   * credential variables have to be cleared before `claude` runs is a different
   * answer for a subscription than for an API key, and getting it wrong is
   * silent in both directions (`foreignCredentialVariables`).
   */
  claudeAuthScheme: ClaudeAuthScheme;
  /**
   * The model this deployment runs when a job does not name one.
   *
   * Absent means Claude Code's default. A job's own choice wins over this.
   */
  model?: string;
}
