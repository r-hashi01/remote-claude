import { describe, expect, test } from 'vitest';
import {
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  assessRunnerHealth,
  exceededDeadline,
} from './health';

const LIMITS = {
  stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
  heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
};

describe('exceededDeadline', () => {
  test('says nothing while the job is inside its budget', () => {
    expect(exceededDeadline({ now: 1_000, startedAt: 0, jobTimeoutMs: 5_000 })).toBeNull();
  });

  test('reports the budget it blew, in the units it was configured in', () => {
    expect(exceededDeadline({ now: 6_000, startedAt: 0, jobTimeoutMs: 5_000 })).toMatch(
      /exceeded 5000ms/
    );
  });

  test('a job that has not started cannot be over its deadline', () => {
    expect(exceededDeadline({ now: 10_000, jobTimeoutMs: 5_000 })).toBeNull();
  });
});

describe('assessRunnerHealth', () => {
  const startedAt = 0;

  test('a runner that is beating and producing output is healthy', () => {
    const verdict = assessRunnerHealth({
      now: 10_000,
      startedAt,
      lastProgressAt: 8_000,
      heartbeatAt: 9_000,
      phase: 'agent',
      ...LIMITS,
    });
    expect(verdict.kind).toBe('healthy');
  });

  // Liveness and progress are different questions: a runner looping forever
  // heartbeats perfectly happily.
  test('a beating runner that has produced nothing for a long time is stalled', () => {
    const now = DEFAULT_STALL_TIMEOUT_MS + 60_000;
    const verdict = assessRunnerHealth({
      now,
      startedAt,
      lastProgressAt: 0,
      heartbeatAt: now - 1_000,
      phase: 'install',
      ...LIMITS,
    });
    expect(verdict.kind).toBe('stalled');
    expect(verdict.reason).toMatch(/no output for 9 minutes during "install"; presumed stuck/);
  });

  test('a runner that stopped beating is reported as gone, with the phase it died in', () => {
    const now = DEFAULT_HEARTBEAT_TIMEOUT_MS + 30_000;
    const verdict = assessRunnerHealth({
      now,
      startedAt,
      lastProgressAt: now - 1_000,
      heartbeatAt: 0,
      phase: 'agent',
      ...LIMITS,
    });
    expect(verdict.kind).toBe('unresponsive');
    expect(verdict.reason).toMatch(/runner stopped responding during "agent"/);
    expect(verdict.reason).toMatch(/no heartbeat for 120s/);
  });

  // "Stuck" and "gone" want different responses from whoever reads this, so a
  // runner that is both is reported as the one that happened first.
  test('silence outranks a missing heartbeat when both have expired', () => {
    const now = DEFAULT_STALL_TIMEOUT_MS * 2;
    const verdict = assessRunnerHealth({
      now,
      startedAt,
      lastProgressAt: 0,
      heartbeatAt: 0,
      ...LIMITS,
    });
    expect(verdict.kind).toBe('stalled');
  });

  test('before anything has been reported, the start time is the reference point', () => {
    const verdict = assessRunnerHealth({ now: 1_000, startedAt: 0, ...LIMITS });
    expect(verdict.kind).toBe('healthy');
  });

  test('a phase nobody reported is called startup', () => {
    const now = DEFAULT_HEARTBEAT_TIMEOUT_MS + 1;
    const verdict = assessRunnerHealth({
      now,
      startedAt: 0,
      lastProgressAt: now,
      heartbeatAt: 0,
      ...LIMITS,
    });
    expect(verdict.reason).toMatch(/"startup"/);
  });
});
