import type { JobStatus } from './status';

// Re-exported so callers that need a record and its status do not have to know
// which of the two files each lives in.
export type { JobStatus } from './status';

/**
 * The persisted and published shape of a job.
 *
 * A record is data, not behaviour — `Job` is the thing with rules. Records
 * exist because a job has to survive being written to storage and read by
 * somebody else's process, and because this shape is the API's contract (see
 * `src/sdk-contract.ts`).
 */

/** A finished command step, surfaced in the job result. */
export interface StepResult {
  name: string;
  command: string;
  exitCode: number;
  success: boolean;
  durationMs: number;
  /** Tail of the combined output, already redacted. */
  output: string;
  skipped?: boolean;
}

/** What a job consumed. Produced by Claude Code. */
export interface JobUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  turns: number | null;
}

export interface JobResult {
  usage?: JobUsage | null;
  /**
   * The agent step's raw stdout (redacted, truncated) — an NDJSON event stream.
   * For the closing message a person would read, see `JobRecord.finalText`.
   */
  claudeOutput: string;
  changed: boolean;
  commitSha?: string;
  branch: string;
  pushed: boolean;
  gitStatus: string;
  diffStat: string;
  /** Byte length of the stored patch; fetch it via GET /jobs/:id/diff. */
  diffBytes: number;
  steps: StepResult[];
}

export interface JobOptions {
  skipChecks: boolean;
  keepSandbox: boolean;
  push: boolean;
}

/**
 * The commands run around the agent, in the order they run.
 *
 * An empty string means "skip this step" — which is a real instruction, not a
 * missing value, and is why overrides keep empty strings.
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
  /** Present on status=failed. Redacted. */
  error?: string;
  /** Set once the sandbox has been reclaimed. Drives the orphan sweep. */
  sandboxDestroyed?: boolean;
  /** Highest log sequence mirrored from the container runner so far. */
  logSeq?: number;
  /** Launch attempts so far. Only the pre-runner window is ever retried. */
  attempts?: number;
  /** When output last advanced. Progress, as distinct from liveness. */
  lastProgressAt?: number;
  /** What the agent consumed. Recorded as it arrives, so a failure keeps it. */
  usage?: JobUsage;
  /**
   * The agent's closing message, taken from the result event.
   *
   * Kept separately from `result.claudeOutput`: since the agent runs with
   * `--output-format stream-json`, that field is the raw event stream, which is
   * the right thing to keep for debugging and the wrong thing to show a person.
   */
  finalText?: string;
  result?: JobResult;
  options: JobOptions;
  /**
   * Commands this job runs instead of the deployment's.
   *
   * Present because a job may name its own repository, and a repository's build
   * commands belong to it rather than to whichever repository the executor was
   * configured for. Only the keys given are overridden.
   */
  commands?: Partial<JobCommands>;
}

/**
 * A job without the bulk — everything a list view needs and nothing it does not.
 *
 * `JobResult.steps` carries every step's captured output, which for one real
 * job was 69 KB. Twenty of those is a megabyte and a half per refresh, for a
 * list that displays none of it. The prompt stays in full: knowing what was
 * asked is the whole point of looking.
 */
export type JobSummary = Omit<JobRecord, 'result'> & {
  result?: Pick<JobResult, 'changed' | 'commitSha' | 'branch' | 'pushed' | 'diffStat' | 'diffBytes'>;
};

/** What a caller asks for. Validated into a `Job` by `Job.create`. */
export interface JobRequest {
  prompt: string;
  baseBranch?: string;
  repo?: string;
  /**
   * Run these instead of the deployment's install/lint/test/build.
   *
   * Required in practice whenever `repo` is used: the deployment's commands were
   * written for the repository it is configured with. Unspecified keys inherit.
   */
  commands?: Partial<JobCommands>;
  /** Work on this branch instead of a generated one. */
  branch?: string;
  /** Skip lint/test/build even when configured. */
  skipChecks?: boolean;
  /** Leave the sandbox alive after the job for manual inspection. */
  keepSandbox?: boolean;
  /** Push the branch to origin. Requires ALLOW_PUSH=true on the Worker. */
  push?: boolean;
}

/**
 * Declared as a type alias rather than an interface on purpose: only aliases
 * get an implicit index signature, which `SqlStorage.exec<T>()` requires.
 */
export type LogLine = {
  seq: number;
  ts: number;
  stream: 'system' | 'stdout' | 'stderr';
  line: string;
};

export type LogStream = LogLine['stream'];
