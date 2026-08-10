import { describe, expect, test } from 'vitest';
import { MAX_LAUNCH_ATTEMPTS, shouldRetryLaunch } from './retry';

describe('shouldRetryLaunch', () => {
  // Observed in normal use: the sandbox runtime is updated underneath a running
  // operation and it is interrupted mid-flight. That is the platform being
  // busy, not this job being broken.
  test.each([
    'Error updating the sandbox runtime, please try again',
    'container unavailable',
    'service temporarily unavailable',
    'upstream returned 503',
  ])('retries after a busy platform: %s', (message) => {
    expect(shouldRetryLaunch(message, 0)).toBe(true);
  });

  test('does not retry a job that is simply broken', () => {
    expect(shouldRetryLaunch('invalid branch name: nope', 0)).toBe(false);
  });

  test('gives up after the attempt budget', () => {
    expect(shouldRetryLaunch('container unavailable', MAX_LAUNCH_ATTEMPTS - 2)).toBe(true);
    expect(shouldRetryLaunch('container unavailable', MAX_LAUNCH_ATTEMPTS - 1)).toBe(false);
  });
});
