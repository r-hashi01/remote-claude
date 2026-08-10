import { describe, expect, test } from 'vitest';
import { MAX_LAUNCH_ATTEMPTS, shouldRetryLaunch, shouldRetrySilentStartup } from './retry';

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

describe('shouldRetrySilentStartup', () => {
  const base = { runnerReportedStatus: false, runnerOutput: '', attemptsSoFar: 0 };

  // Seen twice in five launches: the runner is written and started, the exec
  // returns, and then nothing — no status file and an empty log. The runner
  // writes its status before it does anything else, so both being absent means
  // nothing was executed, which is the one window ADR 0006 says is safe.
  test('retries a runner that reported nothing at all', () => {
    expect(shouldRetrySilentStartup(base)).toBe(true);
  });

  test('does not retry once the runner has said anything', () => {
    expect(shouldRetrySilentStartup({ ...base, runnerOutput: 'Error: out of memory' })).toBe(false);
  });

  test('does not retry a runner that got as far as writing its status', () => {
    expect(shouldRetrySilentStartup({ ...base, runnerReportedStatus: true })).toBe(false);
  });

  test('shares the launch attempt budget', () => {
    expect(shouldRetrySilentStartup({ ...base, attemptsSoFar: MAX_LAUNCH_ATTEMPTS - 2 })).toBe(true);
    expect(shouldRetrySilentStartup({ ...base, attemptsSoFar: MAX_LAUNCH_ATTEMPTS - 1 })).toBe(false);
  });
});
