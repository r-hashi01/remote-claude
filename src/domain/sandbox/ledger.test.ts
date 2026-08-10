import { describe, expect, test } from 'vitest';
import { KEEP_GRACE_MS, sandboxIdForJob, shouldReclaim, summariseLedger } from './ledger';

const NOW = 1_000_000;

function reclaim(overrides: Partial<Parameters<typeof shouldReclaim>[0]> = {}): boolean {
  return shouldReclaim({
    now: NOW,
    jobIsTerminal: true,
    jobIsRunning: false,
    keepSandbox: false,
    finishedAt: NOW - 1_000,
    ...overrides,
  });
}

describe('shouldReclaim', () => {
  test('reclaims the sandbox of a finished job', () => {
    expect(reclaim()).toBe(true);
  });

  test('never touches a sandbox whose job is still in flight', () => {
    expect(reclaim({ jobIsRunning: true })).toBe(false);
    expect(reclaim({ jobIsTerminal: false })).toBe(false);
  });

  // "Keep" means keep for inspection, not keep forever.
  test('respects a keep request, but only for the grace period', () => {
    expect(reclaim({ keepSandbox: true, finishedAt: NOW - 60_000 })).toBe(false);
    expect(reclaim({ keepSandbox: true, finishedAt: NOW - KEEP_GRACE_MS - 1 })).toBe(true);
  });
});

describe('summariseLedger', () => {
  const entries = [
    { id: 'rc-a', jobId: 'a', createdAt: 1, destroyedAt: 2, attempts: 1, lastError: null },
    { id: 'rc-b', jobId: 'b', createdAt: 3, destroyedAt: null, attempts: 2, lastError: 'nope' },
  ];

  test('separates what is outstanding from what came back', () => {
    const ledger = summariseLedger(entries, ['b']);
    expect(ledger.outstanding.map((entry) => entry.id)).toEqual(['rc-b']);
    expect(ledger.destroyed).toBe(1);
    expect(ledger.running).toEqual(['b']);
    expect(ledger.entries).toHaveLength(2);
  });
});

describe('sandboxIdForJob', () => {
  test('derives the sandbox id from the job id', () => {
    expect(sandboxIdForJob('m8x2k1-ab12cd34')).toBe('rc-m8x2k1-ab12cd34');
  });
});
