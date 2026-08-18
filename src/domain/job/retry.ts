
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
/**
 * Whether to try again, asked of the platform rather than of its wording.
 *
 * The SDK raises structured errors carrying `retryable`, and this reads it. Two
 * distinctions that message matching could not make: a destroyed sandbox and a
 * replaced runtime read almost the same and want opposite answers, and an operation
 * whose effects already landed is not one a retry repeats — it is one a retry
 * executes twice, which is the line ADR 0006 draws and previously had to guess at
 * from what had been written to disk.
 *
 * Falls back to the message when there is nothing structured to read. That happens:
 * an error that crossed a Durable Object boundary arrives with its name and message
 * and without its context, and not every failure comes from the SDK at all.
 */
export interface WhatThePlatformSaid {
  /** `context.retryable`, when the platform's report had one. */
  retryable?: boolean | undefined;
  /** `context.admitted`, when it had one. Its three values, unchanged. */
  admitted?: boolean | 'unknown' | undefined;
}

export function shouldRetryPlatformFailure(
  said: WhatThePlatformSaid | null,
  message = ''
): boolean {
  // Effects that reached the container are not repeated by a retry; they are done
  // twice. This is the line ADR 0006 drew and had to infer from files on disk.
  if (said?.admitted === true) return false;
  if (said?.retryable !== undefined) return said.retryable;
  return isTransientPlatformError(message);
}

/**
 * The wording rule, kept for failures that arrive without context.
 *
 * No longer the decision — see `shouldRetryPlatformFailure`. It stays because it is
 * the only thing left to read when the structure has been stripped, and because
 * each pattern here was added by a real job that failed.
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
  /**
   * Whether files the executor itself wrote into the container are missing.
   *
   * The signature that leaves no error to notice. A sandbox is addressed by id,
   * so once the instance behind it is gone the next call quietly gets a fresh
   * empty one: every operation succeeds, nothing throws, and the runner the
   * executor installed is simply not on disk. Its absence is the evidence.
   */
  stateDirectoryEmptied: boolean;
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
 * work, so there is no partial state to respect. Observed twice: twelve seconds
 * after a deploy, the rollout draining the instance underneath a live job, and
 * then at the two-minute mark when the sandbox's inactivity timer slept a
 * container whose only occupant was a background process. The job's own doing in
 * no part of either.
 *
 * A missing process is required on top of the container evidence: on its own it
 * could be a runner that exited by itself, and that exit is worth reporting
 * rather than papering over with another attempt.
 */
export function shouldRetryLostContainer(
  input: LostContainerInput,
  maxAttempts: number = MAX_LAUNCH_ATTEMPTS
): boolean {
  if (!input.platformInterrupted && !input.stateDirectoryEmptied) return false;
  if (!input.runnerProcessMissing) return false;
  if (input.lastKnownPhase && PHASES_THAT_REACH_OUTSIDE.has(input.lastKnownPhase)) return false;
  return input.attemptsSoFar + 1 < maxAttempts;
}

export function shouldRetryLaunch(
  message: string,
  attemptsSoFar: number,
  said: WhatThePlatformSaid | null = null,
  maxAttempts: number = MAX_LAUNCH_ATTEMPTS
): boolean {
  return shouldRetryPlatformFailure(said, message) && attemptsSoFar + 1 < maxAttempts;
}
