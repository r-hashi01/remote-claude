import {
  ContainerUnavailableError,
  OperationInterruptedError,
  RPCTransportError,
  isPlatformTransientError,
} from '@cloudflare/sandbox';
import { PlatformFailure } from '../../domain/job/platform-failure';

/**
 * Read what the platform said, and re-raise it in a shape the layers above can use.
 *
 * The SDK's errors carry a categorical reason, a `retryable` flag, the lifecycle
 * phase, and whether the operation's effects were admitted. None of it was reaching
 * anybody: the layers above matched the message with a regular expression and the
 * job's record kept the message alone. A container start failed and cost a day to
 * investigate, when `reason` would have said in one word whether a deploy replaced
 * the runtime or the sandbox had been destroyed.
 *
 * The translation lives here because this is the only file allowed to know the SDK
 * for execution purposes, and the domain imports nothing (ADR 0008). Everything
 * above works on `PlatformFailureDetails`, which is why the rules that use it can be
 * tested without a runtime.
 */
export function asPlatformFailure(error: unknown, operation: string): unknown {
  if (error instanceof PlatformFailure) return error;

  if (error instanceof OperationInterruptedError) {
    const context = error.context;
    return new PlatformFailure(error.message, {
      reason: context.reason,
      retryable: context.retryable,
      phase: context.phase,
      operation: context.operation ?? operation,
      admitted: context.admitted,
    });
  }

  if (error instanceof ContainerUnavailableError) {
    return new PlatformFailure(error.message, {
      reason: error.reason,
      // Documented as always true: the container is starting, unhealthy or being
      // replaced, and the operation that hit it can be tried again.
      retryable: true,
      operation,
      // Nothing was admitted: the connection never carried the operation.
      admitted: false,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    });
  }

  if (error instanceof RPCTransportError) {
    return new PlatformFailure(error.message, {
      reason: error.kind,
      retryable: true,
      operation,
      // The session died mid-call; whether the far side ran it is not knowable from
      // here, and saying `false` would licence a retry that repeats work.
      admitted: 'unknown',
    });
  }

  // Everything else the SDK considers a platform hiccup rather than an application
  // failure. No reason to read, so the message is what the rules fall back to.
  if (isPlatformTransientError(error)) {
    return new PlatformFailure(
      error instanceof Error ? error.message : String(error),
      { retryable: true, operation, admitted: 'unknown' },
    );
  }

  return error;
}

/** Run an operation, and re-raise anything the platform says something about. */
export async function reporting<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asPlatformFailure(error, operation);
  }
}
