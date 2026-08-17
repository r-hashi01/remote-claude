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

/**
 * One step of the pipeline, in the order it ran.
 *
 * Not only the commands a caller configures. The executor's own steps are here
 * as well — the environment check it runs before anything else, the git
 * operations that put the work on a branch, and the agent run itself — so a real
 * job carries a dozen or more. `install`, `lint`, `test` and `build` are the four
 * that `commands` replaces; the rest are the pipeline's and their names are not
 * a contract.
 *
 * Worth saying because this is what a consumer displays. Read as "the four
 * configured commands", a step named `verify-environment` looks like something
 * nobody asked for.
 */
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
  /** The `--stat` of the same range `getDiff` returns: the branch, not the turn. */
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
/** What a job asks for when it wants its work opened as a pull request. */
export interface PullRequestRequest {
  title?: string;
  body?: string;
  draft?: boolean;
}

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
  /** What this job asked for, if it asked for a pull request. */
  pullRequest?: PullRequestRequest;
  /**
   * The model this job asked for, if it asked for one.
   *
   * Absent means it ran whatever the executor is configured with, which the
   * executor reports through `GET /health/auth` rather than per job.
   */
  model?: string;
  /**
   * The job this one continues, when it is a follow-up turn.
   *
   * A continuation runs on the same branch as the job it continues, so the diff
   * and any pull request keep growing in one place.
   */
  continues?: string;
  /**
   * The pull request the executor opened.
   *
   * Absent when none was asked for, or when opening one failed — the branch is
   * still pushed in that case, so absence here is not absence of a result.
   */
  pullRequestUrl?: string;
  /**
   * Whether this job's tree and conversation were kept, and so whether
   * `continueJob` can work on it.
   *
   * Present from the moment the job reports itself finished — the executor stores
   * the workspace before writing the terminal status, precisely so that a caller
   * who waits for a job and then answers it is not told there is nothing to
   * continue. Absent means a follow-up turn will be refused: no bucket is bound on
   * that deployment, the job stopped before the agent ran, or the retention window
   * has passed.
   *
   * Worth reading before offering somebody a reply box. The alternative is asking
   * and handling the refusal, which works but tells the person after they typed.
   *
   * Opaque: only the executor that produced it may interpret the contents. The
   * shape mirrors the executor's, which is an index signature narrowed to what
   * survives a Durable Object round trip — so `provider` is the only key promised,
   * and reading anything else means depending on which provider answered.
   */
  workspace?: {
    provider: string;
    [detail: string]: string | number | boolean | null | undefined;
  };
  /**
   * What the runner last said it was doing: `installing`, `running`, `checking`,
   * and so on.
   *
   * The executor's own word for where a run is up to, remembered rather than read
   * live — so it still says something after the container is gone. Free-form on
   * purpose: these are the pipeline's names and adding one is not a breaking
   * change, so display it rather than branching on it.
   */
  phase?: string;
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
  /**
   * Open a pull request for the branch. Implies `push`.
   *
   * Every field is optional: the executor composes a title from the prompt and a
   * body from what its own pipeline observed — the diffstat and the checks it
   * ran, not the agent's account of itself. A caller that knows which work item
   * this was should override them.
   */
  pullRequest?: PullRequestRequest;
  /**
   * Run this model instead of the executor's configured one.
   *
   * An alias (`opus`, `sonnet`, `haiku`) or a model id
   * (`claude-opus-4-5-20251101`). Unspecified uses the executor's `CLAUDE_MODEL`,
   * and an executor that has not set one uses Claude Code's own default. The
   * executor keeps no list of valid models — anything shaped like a name is
   * passed through, and a name Anthropic does not know fails at the agent step.
   */
  model?: string;
}

/**
 * A follow-up turn on a finished job.
 *
 * Only the prompt is required — the answer to whatever the previous turn stopped
 * for. Everything else is inherited from the job being continued: the
 * repository, the base, the branch, the commands, and the model. The options
 * here override that job's, rather than resetting them.
 */
export interface ContinueJob {
  prompt: string;
  skipChecks?: boolean;
  keepSandbox?: boolean;
  push?: boolean;
  commands?: Partial<JobCommands>;
  pullRequest?: PullRequestRequest;
  /** Switch models for this turn. Unspecified keeps the previous turn's. */
  model?: string;
}

export type LogStream = 'system' | 'stdout' | 'stderr';

export interface LogLine {
  seq: number;
  ts: number;
  stream: LogStream;
  line: string;
}

/**
 * A window of a job's raw output.
 *
 * Bytes as the commands produced them — unsplit and untruncated, which is the
 * difference from `LogPage`. That answers where a run is up to; this answers what is
 * happening.
 */
export interface OutputWindow {
  /** The output, already redacted. Empty when nothing new has arrived. */
  text: string;
  /** Where to read from next. What you were shown, not what was read. */
  nextOffset: number;
  /** How many bytes the file holds now, for deciding where to start. */
  size: number;
  /** Whether the job can produce no more. */
  done: boolean;
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
