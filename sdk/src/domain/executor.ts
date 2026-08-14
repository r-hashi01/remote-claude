/**
 * The executor itself, as opposed to the jobs it runs.
 *
 * Two things a caller can ask about a deployment rather than about a job:
 * whether its Claude credential works, and what it has allocated.
 */

/**
 * Result of the executor's end-to-end Claude authentication probe.
 *
 * `authScheme` is which credential answered — `subscription-oauth` or
 * `anthropic-api-key`. Worth reading even when `ok` is true: an executor
 * configured with the credential you did not mean to use works perfectly and
 * bills the wrong account.
 */
export interface AuthProbe {
  ok: boolean;
  /** Why there is nothing to probe: no credential configured, or two of them. */
  reason?: string;
  authMode?: 'proxy' | 'direct';
  authScheme?: string;
  /** A real API key inside the container. Only the API-key scheme in direct mode. */
  apiKeyInContainer?: boolean;
  /** Either credential inside the container — that is, direct mode. */
  credentialInContainer?: boolean;
  /** The model the executor runs. Absent means Claude Code's own default. */
  model?: string;
  output?: string;
}

export interface SandboxLedgerEntry {
  id: string;
  jobId: string;
  createdAt: number;
  /** Null while the sandbox has not been confirmed destroyed. */
  destroyedAt: number | null;
  attempts: number;
  lastError: string | null;
}

/**
 * What a deployment has allocated and whether it got it back.
 *
 * `outstanding` is the number that matters: each entry is a sandbox it created
 * and has not confirmed destroyed, and each one consumes its concurrency.
 */
export interface SandboxLedger {
  outstanding: SandboxLedgerEntry[];
  destroyed: number;
  running: string[];
  entries: SandboxLedgerEntry[];
}
