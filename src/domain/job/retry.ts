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
 * Both observed wordings share one phrase, and matching that is narrower than
 * matching either cause:
 *
 *   Sandbox operation sandbox.exec was interrupted while the platform was
 *     updating the sandbox runtime
 *   Sandbox operation commands.execute was interrupted while the runtime
 *     connection was closing
 *
 * The second one cost a real job. It failed during the clone — before the runner
 * existed, so nothing had run — and was not retried only because the pattern
 * knew the first phrasing and not the second. A rule that recognises one wording
 * of a platform hiccup and not another is a rule that will keep being surprised.
 */
export function isTransientPlatformError(message: string): boolean {
  return /was interrupted while|updating the sandbox runtime|container unavailable|temporarily unavailable|503/i.test(
    message
  );
}

export interface SilentStartupInput {
  /** Whether the runner had written its status file. */
  runnerReportedStatus: boolean;
  /** The runner's own stdout/stderr, trimmed. */
  runnerOutput: string;
  /**
   * Whether any of the job's log has been mirrored yet.
   *
   * The strongest of the three, and the one that was missing: a job with lines
   * in its log has executed, whatever the other two say. Without this, a healthy
   * job was requeued in the middle of its agent step — install had already run
   * for forty-three seconds — because the status file happened to be unreadable
   * on one poll.
   */
  producedOutput: boolean;
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
  if (input.producedOutput) return false;
  if (input.runnerReportedStatus) return false;
  if (input.runnerOutput.trim() !== '') return false;
  return input.attemptsSoFar + 1 < maxAttempts;
}

/**
 * Phases from which a retry would repeat something the container did not keep.
 *
 * Everything up to the push happens inside the container and dies with it, so
 * running it again costs time and nothing else. The push is the first step that
 * leaves a mark somewhere that outlives the sandbox.
 */
const PHASES_THAT_REACH_OUTSIDE = new Set(['pushing']);

export interface LostContainerInput {
  /** Whether talking to the sandbox failed with a platform error this poll. */
  platformInterrupted: boolean;
  /** Whether the platform has stopped holding the runner process. */
  runnerProcessMissing: boolean;
  /** The last phase the runner was seen in, if it was ever seen in one. */
  lastKnownPhase?: string;
  attemptsSoFar: number;
}

/**
 * A container the platform took away while the job was still using it.
 *
 * Distinct from every other retry rule here, which are all about the window
 * before anything ran. This one deliberately retries a job that *had* run: the
 * container is gone, and with it the workspace, the checkout and the agent's
 * work, so there is no partial state to respect. Observed twelve seconds after a
 * deploy, the container rollout draining the instance underneath a live job —
 * the job's own doing in no part of it.
 *
 * Both conditions are required. A platform error alone could be a hiccup on one
 * call; a missing process alone could be a runner that exited on its own, and
 * its exit is worth reporting rather than papering over.
 */
export function shouldRetryLostContainer(
  input: LostContainerInput,
  maxAttempts: number = MAX_LAUNCH_ATTEMPTS
): boolean {
  if (!input.platformInterrupted) return false;
  if (!input.runnerProcessMissing) return false;
  if (input.lastKnownPhase && PHASES_THAT_REACH_OUTSIDE.has(input.lastKnownPhase)) return false;
  return input.attemptsSoFar + 1 < maxAttempts;
}

export function shouldRetryLaunch(
  message: string,
  attemptsSoFar: number,
  maxAttempts: number = MAX_LAUNCH_ATTEMPTS
): boolean {
  return isTransientPlatformError(message) && attemptsSoFar + 1 < maxAttempts;
}
