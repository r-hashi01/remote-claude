/**
 * What this deployment allocated, and whether it got it back.
 *
 * The ledger exists because there was no way to answer that. The container
 * platform's instance count reports provisioned capacity rather than running
 * containers, so no external metric can answer it either — but the executor
 * creates the sandboxes, so the executor can record them.
 *
 * The stakes are not money: an orphaned sandbox consumes `max_instances`, so a
 * leak blocks the queue. Four failed jobs once left three live containers,
 * exactly filling the limit.
 */

/**
 * A type alias rather than an interface on purpose: only aliases get the
 * implicit index signature that `SqlStorage.exec<T>()` requires.
 */
export type SandboxLedgerEntry = {
  id: string;
  jobId: string;
  createdAt: number;
  /** Null while the sandbox has not been confirmed destroyed. */
  destroyedAt: number | null;
  attempts: number;
  lastError: string | null;
};

export interface SandboxLedger {
  /** Allocated and not confirmed reclaimed. This is the number that matters. */
  outstanding: SandboxLedgerEntry[];
  destroyed: number;
  /** Job ids currently executing, so outstanding entries can be explained. */
  running: string[];
  entries: SandboxLedgerEntry[];
}

/** The sandbox a job runs in. One job, one sandbox, never reused. */
export function sandboxIdForJob(jobId: string): string {
  return `rc-${jobId}`;
}

/** Grace period before reclaiming a sandbox a caller asked to keep. */
export const KEEP_GRACE_MS = 30 * 60 * 1000;

export interface ReclaimInput {
  now: number;
  /** Whether the job that owns it has reached a terminal state. */
  jobIsTerminal: boolean;
  /** Whether the executor still has the job in flight. */
  jobIsRunning: boolean;
  keepSandbox: boolean;
  /** When the job settled, or was created if it never did. */
  finishedAt: number;
}

/**
 * Whether an outstanding sandbox should be destroyed now.
 *
 * "Keep" means keep for inspection, not keep forever — which is why a kept
 * sandbox is still reclaimed once the grace period is up.
 */
export function shouldReclaim(input: ReclaimInput): boolean {
  if (input.jobIsRunning || !input.jobIsTerminal) return false;
  if (input.keepSandbox && input.now - input.finishedAt < KEEP_GRACE_MS) return false;
  return true;
}

export function summariseLedger(entries: SandboxLedgerEntry[], running: string[]): SandboxLedger {
  return {
    outstanding: entries.filter((entry) => entry.destroyedAt === null),
    destroyed: entries.filter((entry) => entry.destroyedAt !== null).length,
    running,
    entries,
  };
}
