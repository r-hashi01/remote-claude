import { describe, expect, test } from 'vitest';
import {
  MAX_LAUNCH_ATTEMPTS,
  shouldRetryLaunch,
  shouldRetryLostContainer,
  shouldRetrySilentStartup,
} from './retry';

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

/**
 * The case that motivated this: a job ran its install, entered its agent step,
 * and then every call into the sandbox failed with "commands.execute was
 * interrupted while the runtime connection was closing" while the platform no
 * longer held the runner process. The container had been taken away — twelve
 * seconds after a deploy, mid-rollout. The job was failed permanently for
 * something that had nothing to do with the job.
 */
describe('shouldRetryLostContainer', () => {
  const base = {
    platformInterrupted: true,
    stateDirectoryEmptied: false,
    runnerProcessMissing: true,
    lastKnownPhase: 'running',
    attemptsSoFar: 0,
  };

  test('retries a container the platform took away mid-run', () => {
    expect(shouldRetryLostContainer(base)).toBe(true);
  });

  /**
   * The signature that got past the first version of this rule. A sandbox is
   * addressed by id, so when the instance behind it is gone the next call quietly
   * gets a new empty one — every operation succeeds, no error is raised, and the
   * files the executor itself wrote are simply not there. Requiring a platform
   * error to have been seen missed the case that leaves no error at all.
   */
  test('retries when the container has lost files the executor wrote', () => {
    expect(
      shouldRetryLostContainer({
        ...base,
        platformInterrupted: false,
        stateDirectoryEmptied: true,
      })
    ).toBe(true);
  });

  // The whole point is that the container is gone, so nothing survived to be
  // half-done. A runner the platform is still holding is a different failure and
  // re-running the prompt would not be a retry of anything.
  test('does not retry a runner the platform is still holding', () => {
    expect(shouldRetryLostContainer({ ...base, runnerProcessMissing: false })).toBe(false);
  });

  test('does not retry unless something says the container is gone', () => {
    expect(
      shouldRetryLostContainer({ ...base, platformInterrupted: false, stateDirectoryEmptied: false })
    ).toBe(false);
  });

  // Everything before the push happens inside the container and dies with it.
  // The push is the first thing that leaves a mark elsewhere, so from there on a
  // retry is not free and the job stays failed.
  test('does not retry once the job had started pushing', () => {
    expect(shouldRetryLostContainer({ ...base, lastKnownPhase: 'pushing' })).toBe(false);
  });

  test('shares the launch attempt budget', () => {
    expect(shouldRetryLostContainer({ ...base, attemptsSoFar: MAX_LAUNCH_ATTEMPTS - 2 })).toBe(true);
    expect(shouldRetryLostContainer({ ...base, attemptsSoFar: MAX_LAUNCH_ATTEMPTS - 1 })).toBe(false);
  });
});
