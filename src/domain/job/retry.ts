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

export function shouldRetryLaunch(
  message: string,
  attemptsSoFar: number,
  maxAttempts: number = MAX_LAUNCH_ATTEMPTS
): boolean {
  return isTransientPlatformError(message) && attemptsSoFar + 1 < maxAttempts;
}
