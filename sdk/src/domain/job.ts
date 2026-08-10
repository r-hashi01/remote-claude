/**
 * A job, as the API describes it.
 *
 * These shapes are re-declared here rather than imported from the executor's
 * source, because this package must install outside that repository and without
 * `@cloudflare/workers-types`. Duplicated types drift, and a client that quietly
 * disagrees with its server is the worst kind of SDK — so the duplication is
 * verified: `src/sdk-contract.ts` in the executor asserts at compile time that
 * what it returns still satisfies what is promised here.
 *
 * The functions are the small amount of meaning every consumer would otherwise
 * re-derive: which statuses are final, whether anything actually changed, and
 * how to say what happened in one line.
 */

export type JobStatus =
  | 'queued'
  /** The sandbox is being created and the repository cloned. */
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Once a job is in one of these it will never change again. */
export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export function isTerminal(status: JobStatus): boolean {
  return (TERMINAL_STATUSES as readonly JobStatus[]).includes(status);
}

/** What a job consumed. Absent until the agent's turn ends. */
export interface JobUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  turns: number | null;
}

/** One configured command (install / lint / test / build) that ran. */
export interface StepResult {
  name: string;
  command: string;
  exitCode: number;
  success: boolean;
  durationMs: number;
  /** Tail of the combined output, already redacted by the executor. */
  output: string;
  skipped?: boolean;
}

export interface JobResult {
  usage?: JobUsage | null;
  /**
   * The agent step's raw stdout — an NDJSON event stream, useful for debugging
   * and not for display. For the closing message a person would read, use
   * `JobRecord.finalText`.
   */
  claudeOutput: string;
  changed: boolean;
  commitSha?: string;
  branch: string;
  pushed: boolean;
  gitStatus: string;
  diffStat: string;
  /** Byte length of the stored patch. Fetch the patch itself with `getDiff`. */
  diffBytes: number;
  steps: StepResult[];
}

export interface JobOptions {
  skipChecks: boolean;
  keepSandbox: boolean;
  push: boolean;
}

/**
 * The commands the executor runs around the agent.
 *
 * An empty string means "skip this step", which is a real instruction rather
 * than a missing value.
 */
export interface JobCommands {
  install: string;
  lint: string;
  test: string;
  build: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  prompt: string;
  repo: string;
  baseBranch: string;
  branch: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Present on status=failed. Redacted by the executor. */
  error?: string;
  /** Set once the sandbox has been reclaimed. */
  sandboxDestroyed?: boolean;
  /** Highest log sequence mirrored from the container so far. */
  logSeq?: number;
  attempts?: number;
  /** When output last advanced. Progress, as distinct from liveness. */
  lastProgressAt?: number;
  usage?: JobUsage;
  /** The agent's closing message. This is the one to show a person. */
  finalText?: string;
  result?: JobResult;
  options: JobOptions;
  /** Commands this job runs instead of the deployment's. */
  commands?: Partial<JobCommands>;
}

/**
 * A job without each step's captured output.
 *
 * What `listJobs` returns. One real job's `result.steps` was 69 KB, so a list of
 * twenty full records is over a megabyte for a view that renders none of it.
 */
export type JobSummary = Omit<JobRecord, 'result'> & {
  result?: Pick<JobResult, 'changed' | 'commitSha' | 'branch' | 'pushed' | 'diffStat' | 'diffBytes'>;
};

export interface StartJob {
  prompt: string;
  baseBranch?: string;
  /**
   * Run against a repository other than the executor's configured one.
   *
   * Refused unless that deployment sets `ALLOW_CUSTOM_REPO=true`, and then only
   * for repositories its GitHub App installation can actually reach. The
   * executor confirms that with GitHub before it starts anything, so a
   * repository nobody granted it access to is a 400 on this call rather than a
   * job that fails minutes later on clone.
   */
  repo?: string;
  /**
   * Run these instead of the deployment's install/lint/test/build.
   *
   * Effectively required whenever `repo` is used: a deployment's commands were
   * written for the repository it is configured with, and the install step runs
   * even when `skipChecks` is set — so a job on another repository has to
   * replace it. Unspecified keys inherit the deployment's.
   *
   * ```ts
   * commands: { install: 'npm ci --no-audit --no-fund', lint: 'npm run typecheck', test: 'npm test', build: '' }
   * ```
   */
  commands?: Partial<JobCommands>;
  /** Work on this branch instead of a generated `claude/<jobId>`. */
  branch?: string;
  /** Skip lint/test/build even when the executor has them configured. */
  skipChecks?: boolean;
  /** Leave the sandbox alive afterwards for manual inspection. */
  keepSandbox?: boolean;
  /** Push the branch. Requires `ALLOW_PUSH=true` on the executor. */
  push?: boolean;
}

export type LogStream = 'system' | 'stdout' | 'stderr';

export interface LogLine {
  seq: number;
  ts: number;
  stream: LogStream;
  line: string;
}

export interface LogPage {
  logs: LogLine[];
  /** Pass back as `since` to continue where this page ended. */
  nextSince: number;
}

/** Did this job actually change anything? */
export function producedChanges(job: JobRecord | JobSummary): boolean {
  return job.status === 'completed' && job.result?.changed === true;
}

/**
 * One line saying what happened, for a UI that has room for a sentence.
 *
 * "Completed" alone is not an outcome anyone can act on: a job that ran
 * perfectly and changed nothing is a different thing from one that produced a
 * diff, and both are different from one that failed.
 */
export function describeOutcome(job: JobRecord | JobSummary): string {
  switch (job.status) {
    case 'queued':
      return 'Waiting to start.';
    case 'starting':
      return 'Starting up: creating a sandbox and cloning the repository.';
    case 'running':
      return 'Running.';
    case 'cancelled':
      return 'Cancelled.';
    case 'failed':
      return job.error ? `Failed: ${job.error}` : 'Failed, with no reason reported.';
    case 'completed':
      if (!job.result) return 'Completed.';
      if (!job.result.changed) return 'Ran, but changed nothing.';
      return `Produced changes: ${job.result.diffStat}`;
  }
}
