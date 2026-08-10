/**
 * The executor itself, as opposed to the jobs it runs.
 *
 * Two things a caller can ask about a deployment rather than about a job:
 * whether its Claude credential works, and what it has allocated.
 */

/** Result of the executor's end-to-end Claude authentication probe. */
export interface AuthProbe {
  ok: boolean;
  reason?: string;
  authMode?: 'proxy' | 'direct';
  authScheme?: string;
  apiKeyInContainer?: boolean;
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
