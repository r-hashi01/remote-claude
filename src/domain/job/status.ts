/**
 * Execution lifecycle of a job.
 *
 * Distinct from whatever the product on the other side of the API calls the
 * work's status. That is a projection derived from these; this is the execution
 * itself, and this layer knows nothing about the other.
 */
export type JobStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Once a job is in one of these it will never change again. */
export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export function isTerminalStatus(status: JobStatus): boolean {
  return (TERMINAL_STATUSES as readonly JobStatus[]).includes(status);
}

/** Has a sandbox allocated to it, or is about to. */
export function isActiveStatus(status: JobStatus): boolean {
  return status === 'starting' || status === 'running';
}
