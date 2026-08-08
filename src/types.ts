import type { AgentSession } from './agent-session';
import type { Sandbox } from './sandbox';
import type { TaskManager } from './task-manager';

export interface Env {
  // --- Durable Object / container bindings ---
  Sandbox: DurableObjectNamespace<Sandbox>;
  TASKS: DurableObjectNamespace<TaskManager>;
  /** One Durable Object per interactive ACP session. */
  ACP: DurableObjectNamespace<AgentSession>;

  /** Domain state: Project / Task / Event / Update / Output / SandboxRun. */
  DB: D1Database;
  /** Output bodies (patches, log archives). Only keys are stored in D1. */
  ARTIFACTS: R2Bucket;

  // --- Optional R2 binding (WORKSPACE_CACHE=on) ---
  BACKUP_BUCKET?: R2Bucket;

  // --- Secrets (wrangler secret put / .dev.vars) ---
  /** Long-lived Claude subscription OAuth token from `claude setup-token`. */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  /** Shared bearer token guarding this Worker's API. */
  REMOTE_CLAUDE_TOKEN?: string;
  /** GitHub App ID. Used with the two fields below to mint short-lived installation tokens for clone/push. */
  GITHUB_APP_ID?: string;
  /** GitHub App private key (PEM, PKCS#8 — see README). */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Installation ID of the App on the target repo/org. */
  GITHUB_APP_INSTALLATION_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  // --- Vars ---
  /** Which SandboxProvider implementation to use. Defaults to "cloudflare". */
  SANDBOX_PROVIDER?: string;
  REPO_URL: string;
  DEFAULT_BASE_BRANCH: string;
  CLAUDE_AUTH_MODE?: string;
  MAX_CONCURRENCY?: string;
  TASK_TIMEOUT_MS?: string;
  CLAUDE_TIMEOUT_MS?: string;
  SANDBOX_SLEEP_AFTER?: string;
  ALLOW_PUSH?: string;
  ALLOW_CUSTOM_REPO?: string;
  WORKSPACE_CACHE?: string;
  WORKSPACE_CACHE_TTL?: string;
  SANDBOX_ALLOWED_HOSTS?: string;
  INSTALL_COMMAND?: string;
  LINT_COMMAND?: string;
  TEST_COMMAND?: string;
  BUILD_COMMAND?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
}

/**
 * Execution lifecycle, distinct from the work status in store/types.ts.
 * A task's *work* status (to_do / ready_for_review / ...) is a projection
 * derived from execution outcomes; this is the execution itself.
 */
export type ExecutionStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** A finished command step, surfaced in the task result. */
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

export interface TaskRequest {
  prompt: string;
  baseBranch?: string;
  repo?: string;
  /** Skip lint/test/build even when configured. */
  skipChecks?: boolean;
  /** Leave the sandbox alive after the task for manual inspection. */
  keepSandbox?: boolean;
  /** Push the branch to origin. Requires ALLOW_PUSH=true on the Worker. */
  push?: boolean;
}

/**
 * Input contract for the runner. Built from the durable Task in D1 — this is
 * not itself persisted anywhere.
 */
export interface TaskRecord {
  id: string;
  status: ExecutionStatus;
  prompt: string;
  repo: string;
  baseBranch: string;
  branch: string;
  createdAt: number;
  options: {
    skipChecks: boolean;
    keepSandbox: boolean;
    push: boolean;
  };
}

/** What the HTTP API and CLI see for a task. */
export interface TaskView {
  id: string;
  title: string;
  prompt: string;
  /** Work status: to_do | in_progress | waiting | ready_for_review | done | failed */
  status: string;
  statusReason: string | null;
  branch: string | null;
  baseBranch: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * True once nothing further will happen without a new request. Computed
   * server-side so clients never have to know the status vocabulary.
   */
  settled: boolean;
  result?: TaskResult;
}

export interface TaskResult {
  /** Claude Code's final stdout (redacted). */
  claudeOutput: string;
  changed: boolean;
  commitSha?: string;
  branch: string;
  pushed: boolean;
  gitStatus: string;
  diffStat: string;
  /** Byte length of the stored patch; fetch it via GET /tasks/:id/diff. */
  diffBytes: number;
  steps: StepResult[];
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
