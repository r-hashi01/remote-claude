import { describe, expect, test } from 'vitest';
import {
  describePlatformReport,
  platformReport,
  reportedAdmitted,
  reportedRetryable,
} from './platform-failure';

/**
 * Reading the platform's error, without becoming a different error.
 *
 * The SDK's errors carry a `code`, a `context` whose fields differ by kind, the
 * operation, and often a suggestion and a documentation link. All of it was being
 * discarded: the decision came from matching the message, and the record kept the
 * message alone.
 *
 * The first attempt copied selected fields into a class of this repository's own and
 * threw that instead — which loses whatever was not copied and replaces the
 * platform's account with ours. So nothing is converted. The error is read where it
 * is caught.
 */

/** An error shaped as the SDK shapes them. */
function sdkError(
  code: string,
  context: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Error {
  const error = new Error('Sandbox operation process.start was interrupted');
  return Object.assign(error, {
    toJSON: () => ({
      name: 'OperationInterruptedError',
      message: error.message,
      code,
      context,
      httpStatus: 503,
      operation: 'process.start',
      suggestion: 'Retry the operation once the container is ready',
      documentation: 'https://developers.cloudflare.com/sandbox/errors',
      timestamp: '2026-08-18T00:00:00.000Z',
      stack: 'Error: …\n    at somewhere',
    }),
  });
}

describe('the platform report on an error', () => {
  test('is whatever the SDK put in it', () => {
    const report = platformReport(
      sdkError('OPERATION_INTERRUPTED', {
        reason: 'runtime_replaced',
        retryable: true,
        phase: 'awaiting-response',
        admitted: false,
      })
    );

    expect(report).toMatchObject({
      code: 'OPERATION_INTERRUPTED',
      operation: 'process.start',
      httpStatus: 503,
      context: {
        reason: 'runtime_replaced',
        retryable: true,
        phase: 'awaiting-response',
        admitted: false,
      },
    });
  });

  // Fields this file has never heard of are carried anyway. The alternative was a
  // case per error class, which flattens anything unlisted to nothing.
  test('carries context this code does not know about', () => {
    const report = platformReport(
      sdkError('SOMETHING_NEW', { reason: 'a_reason_from_next_year', closeCode: 1006 })
    );

    expect(report?.context).toEqual({ reason: 'a_reason_from_next_year', closeCode: 1006 });
  });

  test('drops the stack and nothing else', () => {
    const report = platformReport(sdkError('OPERATION_INTERRUPTED', { reason: 'x' }));

    expect(report).not.toHaveProperty('stack');
    expect(report).toHaveProperty('suggestion');
    expect(report).toHaveProperty('documentation');
    expect(report).toHaveProperty('timestamp');
  });

  test('is absent for anything that is not one of theirs', () => {
    expect(platformReport(new Error('EUSAGE'))).toBeNull();
    expect(platformReport({ toJSON: () => ({ nope: true }) })).toBeNull();
    expect(platformReport('a string')).toBeNull();
  });
});

describe('the line a reader sees', () => {
  // In the platform's words. A gloss was written here once — "not retryable" where
  // the SDK had said `retryable: false` — and a gloss is a second thing to trust.
  test('prints the fields as they came', () => {
    const said = describePlatformReport(
      platformReport(
        sdkError('OPERATION_INTERRUPTED', {
          reason: 'sandbox_lifetime_changed',
          retryable: false,
          admitted: 'unknown',
        })
      )
    );

    expect(said).toContain('code=OPERATION_INTERRUPTED');
    expect(said).toContain('operation=process.start');
    expect(said).toContain('"reason":"sandbox_lifetime_changed"');
    expect(said).toContain('"retryable":false');
    expect(said).toContain('"admitted":"unknown"');
    // The SDK's own advice, verbatim, including where to read more.
    expect(said).toContain('Retry the operation once the container is ready');
    expect(said).toContain('https://developers.cloudflare.com/sandbox/errors');
  });

  test('is empty when there was no report', () => {
    expect(describePlatformReport(null)).toBe('');
  });
});

describe('the two fields a decision needs', () => {
  test('are read without being reinterpreted', () => {
    const report = platformReport(
      sdkError('OPERATION_INTERRUPTED', { retryable: false, admitted: 'unknown' })
    );

    expect(reportedRetryable(report)).toBe(false);
    expect(reportedAdmitted(report)).toBe('unknown');
  });

  test('are undefined when the context did not mention them', () => {
    const report = platformReport(sdkError('SOMETHING_ELSE', { reason: 'x' }));

    expect(reportedRetryable(report)).toBeUndefined();
    expect(reportedAdmitted(report)).toBeUndefined();
  });
});

/**
 * A report that survives being wrapped.
 *
 * The clone path replaces the platform's error with one of its own, because git's
 * message names a URL and a credential and says nothing about which of the two
 * plausible causes it is — so the wrapper says both. Useful, and it threw the
 * platform's report away: `code=` reached the log for every failure except that one.
 *
 * Wrapping is the right thing there. Losing what was wrapped is not, and `cause` is
 * where the original belongs.
 */
describe('a platform report inside a wrapper', () => {
  function sdkStyle(): Error {
    const error = new Error('git.clone was interrupted');
    return Object.assign(error, {
      toJSON: () => ({
        name: 'OperationInterruptedError',
        message: error.message,
        code: 'OPERATION_INTERRUPTED',
        context: { reason: 'runtime_replaced', retryable: true },
        operation: 'git.clone',
      }),
    });
  }

  test('is found through cause', () => {
    const wrapped = new Error('cloning … failed: git.clone was interrupted', {
      cause: sdkStyle(),
    });

    expect(platformReport(wrapped)).toMatchObject({
      code: 'OPERATION_INTERRUPTED',
      operation: 'git.clone',
      context: { reason: 'runtime_replaced', retryable: true },
    });
  });

  test('is found through more than one wrapper', () => {
    const inner = new Error('inner', { cause: sdkStyle() });
    const outer = new Error('outer', { cause: inner });

    expect(platformReport(outer)?.code).toBe('OPERATION_INTERRUPTED');
  });

  // A chain that loops must not become a loop here.
  test('does not follow a cause that points at itself', () => {
    const looped = new Error('round and round');
    (looped as { cause?: unknown }).cause = looped;

    expect(platformReport(looped)).toBeNull();
  });

  test('is still absent when nothing in the chain is one', () => {
    expect(platformReport(new Error('outer', { cause: new Error('inner') }))).toBeNull();
  });
});
