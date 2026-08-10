/**
 * Is this job still worth waiting for?
 *
 * Three separate questions, kept separate because they want different answers
 * from whoever reads them: over its budget, alive but producing nothing, or
 * gone. All three are decided from timestamps alone, which is what makes them
 * testable — the awkward part of this system was never the arithmetic, it was
 * that the arithmetic was buried in a polling loop that talked to a container.
 */

/**
 * How long without a heartbeat before the runner is presumed dead.
 *
 * The runner touches status.json every five seconds. Generous relative to that
 * so a slow poll or a busy container is not mistaken for a corpse, but far
 * short of the job timeout — which used to be the only thing that noticed, and
 * took thirty minutes to do it.
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;

/**
 * How long without any new output before the job is presumed stuck.
 *
 * Progress needs no separate signal — the log's own sequence number already is
 * one. This only became usable once the agent's output was streamed rather than
 * buffered until the step finished; before that a working job and a stuck job
 * looked identical for minutes.
 *
 * Streaming did not make silence rare, only meaningful: *within* a tool call
 * nothing is emitted until its result, and `rm -rf node_modules && npm install`
 * runs well past this with no output at all. That took a real job with it, and
 * the reflex was to widen the window — which would have bought nothing except a
 * later false positive. The runner answers it properly instead: a step quiet for
 * a minute now says so. Silence therefore means the runner itself has stopped,
 * which is the anomaly this rule was written for, so the window can stay tight.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 8 * 60 * 1000;

export interface DeadlineInput {
  now: number;
  /** Absent while the job has not started; it cannot then be over its budget. */
  startedAt?: number;
  jobTimeoutMs: number;
}

/** The reason a job is over its total budget, or null while it is not. */
export function exceededDeadline({ now, startedAt, jobTimeoutMs }: DeadlineInput): string | null {
  if (startedAt === undefined) return null;
  return now - startedAt > jobTimeoutMs ? `job exceeded ${jobTimeoutMs}ms` : null;
}

export interface RunnerHealthInput {
  now: number;
  startedAt?: number;
  /** When output last advanced. */
  lastProgressAt?: number;
  /** `updatedAt` from the runner's status file. */
  heartbeatAt?: number;
  /** What the runner said it was doing. */
  phase?: string;
  stallTimeoutMs: number;
  heartbeatTimeoutMs: number;
}

export type RunnerHealth =
  | { kind: 'healthy'; reason?: undefined; silentForMs?: undefined }
  | { kind: 'stalled'; reason: string; silentForMs: number }
  | { kind: 'unresponsive'; reason: string; silentForMs: number };

export function assessRunnerHealth(input: RunnerHealthInput): RunnerHealth {
  const { now, startedAt, lastProgressAt, heartbeatAt, phase } = input;
  const where = phase ?? 'startup';

  // Before anything has been reported, the start of the job is the last thing
  // known to have happened, and is the honest reference point for both clocks.
  const silentFor = now - (lastProgressAt ?? startedAt ?? now);
  if (silentFor > input.stallTimeoutMs) {
    return {
      kind: 'stalled',
      silentForMs: silentFor,
      reason:
        `no output for ${Math.round(silentFor / 60_000)} minutes during ` +
        `"${where}"; presumed stuck`,
    };
  }

  const sinceBeat = now - (heartbeatAt ?? startedAt ?? now);
  if (sinceBeat > input.heartbeatTimeoutMs) {
    return {
      kind: 'unresponsive',
      silentForMs: sinceBeat,
      reason:
        `runner stopped responding during "${where}" ` +
        `(no heartbeat for ${Math.round(sinceBeat / 1_000)}s).`,
    };
  }

  return { kind: 'healthy' };
}
