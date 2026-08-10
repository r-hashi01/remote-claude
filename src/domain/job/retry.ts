/**
 * How many times to retry a job that failed before its runner started.
 *
 * Only that window is retryable: nothing has been executed yet, so a retry has
 * no side effects. Once the runner is up, a retry would re-run the user's
 * prompt, which is not the same thing at all.
 */
export const MAX_LAUNCH_ATTEMPTS = 3;

/**
 * Errors that mean "the platform was busy", not "this job is broken".
 *
 * Observed twice in normal use: the sandbox runtime is updated underneath a
 * running operation and it is interrupted mid-flight.
 */
export function isTransientPlatformError(message: string): boolean {
  return /updating the sandbox runtime|container unavailable|temporarily unavailable|503/i.test(
    message
  );
}

export interface SilentStartupInput {
  /** Whether the runner had written its status file. */
  runnerReportedStatus: boolean;
  /** The runner's own stdout/stderr, trimmed. */
  runnerOutput: string;
  attemptsSoFar: number;
}

/**
 * A runner that started, said nothing, and stopped.
 *
 * Observed twice in five launches: the runner is written into the sandbox and
 * started, the exec returns successfully, and then there is no status file and an
 * empty log. The runner writes its status before doing anything else, so both
 * being absent means **nothing was executed** — which is exactly the window ADR
 * 0006 says is safe to retry, arrived at by a different route than a throw from
 * `launch()`.
 *
 * Deliberately narrow. One line of output means something may have run, and
 * re-running the caller's prompt is not the same thing as retrying a start.
 */
export function shouldRetrySilentStartup(
  input: SilentStartupInput,
  maxAttempts: number = MAX_LAUNCH_ATTEMPTS
): boolean {
  if (input.runnerReportedStatus) return false;
  if (input.runnerOutput.trim() !== '') return false;
  return input.attemptsSoFar + 1 < maxAttempts;
}

export function shouldRetryLaunch(
  message: string,
  attemptsSoFar: number,
  maxAttempts: number = MAX_LAUNCH_ATTEMPTS
): boolean {
  return isTransientPlatformError(message) && attemptsSoFar + 1 < maxAttempts;
}
