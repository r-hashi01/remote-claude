import { describe, expect, test } from 'vitest';
import { TERMINAL_STATUSES, describeOutcome, isTerminal, producedChanges } from './job.js';
import type { JobRecord } from './job.js';

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    status: 'completed',
    prompt: 'fix the build',
    repo: 'https://github.com/o/r.git',
    baseBranch: 'main',
    branch: 'claude/job-1',
    createdAt: 0,
    options: { skipChecks: false, keepSandbox: false, push: false },
    ...overrides,
  };
}

describe('isTerminal', () => {
  for (const status of TERMINAL_STATUSES) {
    test(`${status} is terminal`, () => {
      expect(isTerminal(status)).toBe(true);
    });
  }

  test.each(['queued', 'starting', 'running'] as const)('%s is not terminal', (status) => {
    expect(isTerminal(status)).toBe(false);
  });
});

describe('producedChanges', () => {
  test('is true only when the job finished and actually changed something', () => {
    expect(producedChanges(job({ result: { ...result(), changed: true } }))).toBe(true);
    expect(producedChanges(job({ result: { ...result(), changed: false } }))).toBe(false);
    // A job can be summarised without a result at all.
    expect(producedChanges(job())).toBe(false);
    expect(producedChanges(job({ status: 'running' }))).toBe(false);
  });
});

describe('describeOutcome', () => {
  test('says what happened in a sentence a person can read', () => {
    expect(describeOutcome(job({ status: 'queued' }))).toMatch(/waiting/i);
    expect(describeOutcome(job({ status: 'running' }))).toMatch(/running/i);
    expect(describeOutcome(job({ status: 'cancelled' }))).toMatch(/cancelled/i);
    expect(describeOutcome(job({ status: 'failed', error: 'the runner died' }))).toMatch(
      /the runner died/
    );
    expect(describeOutcome(job({ status: 'completed', result: { ...result(), changed: false } }))).toMatch(
      /nothing/i
    );
    expect(
      describeOutcome(job({ status: 'completed', result: { ...result(), diffStat: '2 files changed' } }))
    ).toMatch(/2 files changed/);
  });

  test('a failure with no message still says it failed', () => {
    expect(describeOutcome(job({ status: 'failed' }))).toMatch(/failed/i);
  });
});

function result() {
  return {
    claudeOutput: '',
    changed: true,
    branch: 'claude/job-1',
    pushed: false,
    gitStatus: '',
    diffStat: '1 file changed',
    diffBytes: 10,
    steps: [],
  };
}
