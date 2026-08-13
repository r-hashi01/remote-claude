import { describe, expect, test } from 'vitest';
import { isActiveStatus, isTerminalStatus, TERMINAL_STATUSES } from './status';

describe('isTerminalStatus', () => {
  test.each(TERMINAL_STATUSES)('%s will never change again', (status) => {
    expect(isTerminalStatus(status)).toBe(true);
  });

  test.each(['queued', 'starting', 'running'] as const)('%s can still change', (status) => {
    expect(isTerminalStatus(status)).toBe(false);
  });
});

describe('isActiveStatus', () => {
  test.each(['starting', 'running'] as const)('%s has a sandbox allocated, or is about to', (status) => {
    expect(isActiveStatus(status)).toBe(true);
  });

  test.each(['completed', 'failed', 'cancelled'] as const)(
    '%s has already given its sandbox back',
    (status) => {
      expect(isActiveStatus(status)).toBe(false);
    }
  );

  /**
   * `isTerminalStatus` and `isActiveStatus` are not complements of one
   * another: `queued` is false for both. It has not been given a sandbox yet,
   * so it is not active, but it has not run to a conclusion either, so it is
   * not terminal. Code that reclaims sandboxes for jobs that are no longer
   * active must not treat "not active" as "finished" — a queued job is
   * exactly the case where that would be wrong, and collapsing the two checks
   * into one is the mistake this test exists to catch.
   */
  test('queued is neither active nor terminal', () => {
    expect(isActiveStatus('queued')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
  });
});
