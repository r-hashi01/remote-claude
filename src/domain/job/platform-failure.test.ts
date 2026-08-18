import { describe, expect, test } from 'vitest';
import {
  PlatformFailure,
  describePlatformFailure,
  platformDetails,
} from './platform-failure';

/**
 * What the platform said, kept instead of guessed at.
 *
 * The sandbox SDK raises errors carrying a categorical `reason`, a `retryable`
 * flag, the lifecycle `phase`, and whether the operation's effects were `admitted`.
 * None of it was read: the decision came from matching the message with a regular
 * expression, and the message was all that reached the job's record.
 *
 * It cost a day. A container start failed and the record said only that an
 * operation had been interrupted — where `reason` would have said whether a deploy
 * replaced the runtime or the sandbox had been destroyed underneath it.
 */
describe('the details a platform failure carries', () => {
  test('are read off the error the SDK raised', () => {
    const failure = new PlatformFailure('Sandbox operation commands.execute was interrupted', {
      reason: 'runtime_replaced',
      retryable: true,
      phase: 'awaiting-response',
      operation: 'command.execute',
      admitted: 'unknown',
    });

    expect(platformDetails(failure)).toMatchObject({
      reason: 'runtime_replaced',
      retryable: true,
      phase: 'awaiting-response',
    });
  });

  test('are absent from an error that is not one', () => {
    expect(platformDetails(new Error('EUSAGE'))).toBeNull();
    expect(platformDetails('a string')).toBeNull();
  });

  // The line a person reads when a job fails. The old one said an operation had
  // been interrupted and stopped there.
  test('read as a sentence naming the cause and where it happened', () => {
    const said = describePlatformFailure({
      reason: 'runtime_replaced',
      retryable: true,
      phase: 'awaiting-response',
      operation: 'command.execute',
      admitted: 'unknown',
    });

    expect(said).toContain('runtime_replaced');
    expect(said).toContain('awaiting-response');
    expect(said).toContain('command.execute');
    // Whether it may be retried is the reader's next question either way.
    expect(said).toMatch(/retryable/i);
  });

  test('say when the platform gave nothing but a message', () => {
    expect(describePlatformFailure(null)).toBe('');
  });

  // `admitted` answers the question ADR 0006 had to guess: did the work reach the
  // container? A retry after committed effects is not a retry of anything.
  test('carry whether the effects landed', () => {
    expect(
      describePlatformFailure({ reason: 'runtime_replaced', retryable: true, admitted: true })
    ).toMatch(/effects.*committed|committed/i);
  });
});
