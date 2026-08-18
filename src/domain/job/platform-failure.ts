/**
 * What the platform said about a failure, in a shape this layer can read.
 *
 * The sandbox SDK raises structured errors — `OperationInterruptedError`,
 * `ContainerUnavailableError`, `RPCTransportError` — each carrying a categorical
 * reason, whether a retry is safe, the lifecycle phase, and whether the operation's
 * effects reached the container. Every one of those was being thrown away: the
 * decision to retry came from matching the message text, and the message was all
 * that reached the job's record.
 *
 * It cost a day of somebody's time. A container start failed, the record said an
 * operation had been interrupted, and that was the whole account — where `reason`
 * distinguishes a deploy replacing the runtime from the sandbox being destroyed
 * underneath the job, and `admitted` says whether the work had already landed.
 *
 * Declared here rather than imported from the SDK because the domain imports
 * nothing (ADR 0008). The adapter reads the error and fills this in; every rule
 * below works on the shape, so it can be tested without a runtime.
 */

export interface PlatformFailureDetails {
  /**
   * The platform's own word for what happened, verbatim.
   *
   * `runtime_replaced`, `transport_disposed`, `sandbox_lifetime_changed`,
   * `recovery_exhausted` from an interrupted operation; `container_starting`,
   * `container_unhealthy`, `container_replaced`, `rpc_upgrade_failed` from an
   * unavailable container; a transport `kind` otherwise. Not narrowed to a union
   * on purpose: a reason this file has not heard of should arrive in the log
   * intact rather than be flattened to "unknown".
   */
  reason?: string;
  /**
   * Whether the platform says the operation can be retried from the beginning.
   *
   * The answer, where there used to be an inference. `sandbox_lifetime_changed`
   * and `recovery_exhausted` set it false; a replaced runtime sets it true.
   */
  retryable?: boolean;
  /** Where in the operation's lifecycle the interruption was noticed. */
  phase?: string;
  /** Which operation it was: `command.execute`, `backup.restore`, and so on. */
  operation?: string;
  /**
   * Whether the operation's effects reached the container.
   *
   * The question ADR 0006 had to guess at. `false` means nothing ran, so a retry
   * repeats nothing; `true` means it did, so a retry is a second execution rather
   * than another attempt; `'unknown'` means the platform cannot say.
   */
  admitted?: boolean | 'unknown';
  /** How long the platform suggests waiting, when it says. */
  retryAfterMs?: number;
}

/** An error from the platform, carrying what the platform said about it. */
export class PlatformFailure extends Error {
  constructor(
    message: string,
    readonly details: PlatformFailureDetails,
  ) {
    super(message);
    this.name = 'PlatformFailure';
  }
}

/** The details, when the thrown thing carries any. */
export function platformDetails(error: unknown): PlatformFailureDetails | null {
  if (error instanceof PlatformFailure) return error.details;
  // Crossing a Durable Object boundary rebuilds an error from name, message and
  // stack — the same asymmetry that made Refusal answer 500 (ADR 0015's
  // neighbourhood). A failure that arrives that way keeps its name and loses its
  // details, and saying nothing is better than inventing them.
  return null;
}

/**
 * The account a person reads when a job fails on the platform's behalf.
 *
 * Written as a sentence rather than a dump: the reader wants to know what
 * happened, where, and whether it was anybody's fault. Empty when there is nothing
 * structured to say, so a caller can append it to a message unconditionally.
 */
export function describePlatformFailure(details: PlatformFailureDetails | null): string {
  if (!details) return '';

  const parts: string[] = [];
  if (details.reason) parts.push(`reason ${details.reason}`);
  if (details.operation) parts.push(`during ${details.operation}`);
  if (details.phase) parts.push(`at phase ${details.phase}`);
  if (details.retryable !== undefined) {
    parts.push(details.retryable ? 'retryable' : 'not retryable');
  }
  if (details.admitted === true) parts.push('its effects were committed');
  else if (details.admitted === false) parts.push('nothing had run yet');
  else if (details.admitted === 'unknown') parts.push('whether it ran is unknown');

  return parts.length > 0 ? `the platform says: ${parts.join(', ')}` : '';
}
