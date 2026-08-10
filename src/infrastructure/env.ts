import type { AgentSession } from './durable-objects/agent-session';
import type { JobManager } from './durable-objects/job-manager';
import type { Sandbox } from './durable-objects/sandbox';

/**
 * Everything this deployment is given by the platform.
 *
 * The one type in the codebase that is unavoidably Cloudflare-shaped, which is
 * why it lives here and why nothing in `src/domain` or `src/application` imports
 * it. Those layers state what they need as ports; this is where the platform
 * supplies it.
 */
/**
 * The values that must never appear in output.
 *
 * Declared separately from `Env` so that every place which masks secrets can be
 * checked against this list at compile time — see `maskedSecrets`. Adding a
 * credential here and nowhere else is a type error, which is the only reliable
 * way to keep three redactors in agreement: one of them was already missing two
 * of these.
 *
 * `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID` are deliberately absent.
 * They are short numeric identifiers rather than credentials, and masking them
 * would corrupt unrelated output while protecting nothing.
 */
export interface Secrets {
  /** Long-lived Claude subscription OAuth token from `claude setup-token`. */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  /** Shared bearer token guarding this Worker's API. */
  REMOTE_CLAUDE_TOKEN?: string;
  /** GitHub App private key (PEM, PKCS#8 — see README). */
  GITHUB_APP_PRIVATE_KEY?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

export interface Env extends Secrets {
  // --- Durable Object / container bindings ---
  Sandbox: DurableObjectNamespace<Sandbox>;
  JOBS: DurableObjectNamespace<JobManager>;
  /** One Durable Object per interactive ACP session. */
  ACP: DurableObjectNamespace<AgentSession>;

  /** Job artifacts: patch and result bodies. */
  ARTIFACTS: R2Bucket;

  // --- Optional R2 binding (WORKSPACE_CACHE=on) ---
  BACKUP_BUCKET?: R2Bucket;

  // --- Secrets (wrangler secret put / .dev.vars) ---
  // The maskable ones are in `Secrets` above.
  /** GitHub App ID. Used with the private key to mint installation tokens. */
  GITHUB_APP_ID?: string;
  /** Installation ID of the App on the target repo/org. */
  GITHUB_APP_INSTALLATION_ID?: string;

  // --- Vars ---
  /** Which SandboxProvider implementation to use. Defaults to "cloudflare". */
  SANDBOX_PROVIDER?: string;
  REPO_URL: string;
  DEFAULT_BASE_BRANCH: string;
  CLAUDE_AUTH_MODE?: string;
  MAX_CONCURRENCY?: string;
  JOB_TIMEOUT_MS?: string;
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
