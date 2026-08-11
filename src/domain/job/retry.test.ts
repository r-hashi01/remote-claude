import { describe, expect, test } from 'vitest';
import { MAX_LAUNCH_ATTEMPTS, shouldRetryLaunch, shouldRetrySilentStartup } from './retry';

describe('shouldRetryLaunch', () => {
  // Observed in normal use: the sandbox runtime is updated underneath a running
  // operation and it is interrupted mid-flight. That is the platform being
  // busy, not this job being broken.
  // Both of these are real messages from real failed jobs, quoted exactly.
  test.each([
    'Sandbox operation sandbox.exec was interrupted while the platform was updating the sandbox runtime',
    'Sandbox operation commands.execute was interrupted while the runtime connection was closing',
    'Error updating the sandbox runtime, please try again',
    'container unavailable',
    'service temporarily unavailable',
    'upstream returned 503',
  ])('retries after a busy platform: %s', (message) => {
    expect(shouldRetryLaunch(message, 0)).toBe(true);
  });

  // Widening the pattern must not make it match a broken job. These are the
  // failures the executor produces itself, and every one of them is permanent.
  test.each([
    'invalid branch name: no; rm -rf /',
    'prompt is required',
    'cloning https://github.com/o/r.git at branch "nope" failed: fatal: Remote branch nope not found',
    "this executor's GitHub App installation cannot reach o/r",
    'this executor will not push: pushing is disabled on it',
  ])('does not retry a job that is simply broken: %s', (message) => {
    expect(shouldRetryLaunch(message, 0)).toBe(false);
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
  const base = {
    runnerReportedStatus: false,
    runnerOutput: '',
    producedOutput: false,
    attemptsSoFar: 0,
  };

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

  // The one that was missing. A job with lines in its log has executed, whatever
  // the other two signals say — and without this a healthy job was requeued in
  // the middle of its agent step, having already run a forty-three second install.
  test('never retries a job that has produced any output at all', () => {
    expect(shouldRetrySilentStartup({ ...base, producedOutput: true })).toBe(false);
  });

  test('does not retry a runner that got as far as writing its status', () => {
    expect(shouldRetrySilentStartup({ ...base, runnerReportedStatus: true })).toBe(false);
  });

  test('shares the launch attempt budget', () => {
    expect(shouldRetrySilentStartup({ ...base, attemptsSoFar: MAX_LAUNCH_ATTEMPTS - 2 })).toBe(true);
    expect(shouldRetrySilentStartup({ ...base, attemptsSoFar: MAX_LAUNCH_ATTEMPTS - 1 })).toBe(false);
  });
});
