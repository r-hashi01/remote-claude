import { describe, expect, test, vi } from 'vitest';
import type { JobRecord, JobStatus, LogLine } from '../domain/job.js';
import { ExecutorError } from '../infrastructure/errors.js';
import { FakeJobGateway, line } from './testing.js';
import { waitForJob } from './wait-for-job.js';

function state(status: JobStatus, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    status,
    prompt: 'x',
    repo: 'https://github.com/o/r.git',
    baseBranch: 'main',
    branch: 'claude/job-1',
    createdAt: 0,
    options: { skipChecks: false, keepSandbox: false, push: false },
    ...overrides,
  };
}

/** No waiting in tests; assert on what the loop asked for instead. */
const instant = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});

describe('waitForJob', () => {
  test('returns a job that has already finished, without waiting', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('completed')];
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});

    const job = await waitForJob(gateway, 'job-1', { sleep });

    expect(job.status).toBe('completed');
    expect(sleep).not.toHaveBeenCalled();
  });

  test('polls until the job reaches a terminal state, at the interval it was given', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('queued'), state('running'), state('completed')];
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});

    const job = await waitForJob(gateway, 'job-1', { intervalMs: 5_000, sleep });

    expect(job.status).toBe('completed');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]?.[0]).toBe(5_000);
  });

  // Failure and cancellation are outcomes, not exceptions: a caller wants the
  // record and its error, not a throw to unwrap.
  test.each(['failed', 'cancelled'] as const)('resolves on %s', async (status) => {
    const gateway = new FakeJobGateway();
    gateway.states = [state(status, { error: 'nope' })];

    const job = await waitForJob(gateway, 'job-1', { sleep: instant });

    expect(job.status).toBe(status);
    expect(job.error).toBe('nope');
  });

  test('streams log lines in order, each exactly once', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('running'), state('running'), state('completed')];
    gateway.onGet = (attempt) => {
      if (attempt === 0) gateway.lines.push(line(1, 'npm install'));
      if (attempt === 1) gateway.lines.push(line(2, 'added 42 packages'));
      if (attempt === 2) gateway.lines.push(line(3, 'done'));
    };

    const seen: LogLine[] = [];
    await waitForJob(gateway, 'job-1', { sleep: instant, onLog: (lines) => seen.push(...lines) });

    expect(seen.map((entry) => entry.line)).toEqual(['npm install', 'added 42 packages', 'done']);
  });

  // The executor mirrors the container's last lines as it settles, so the tail
  // arrives just after the terminal status does.
  test('reads the tail once more after the job settles', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('completed')];
    gateway.onGet = () => gateway.lines.push(line(1, 'final line'));

    const seen: string[] = [];
    await waitForJob(gateway, 'job-1', { sleep: instant, onLog: (lines) => seen.push(...lines.map((l) => l.line)) });

    expect(seen).toEqual(['final line']);
  });

  test('does not ask for logs when nobody is listening', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('completed')];

    await waitForJob(gateway, 'job-1', { sleep: instant });

    expect(gateway.calls.filter((call) => call.startsWith('logs'))).toEqual([]);
  });

  test('reports each status change once', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('queued'), state('queued'), state('running'), state('completed')];

    const changes: JobStatus[] = [];
    await waitForJob(gateway, 'job-1', { sleep: instant, onStatus: (status) => changes.push(status) });

    expect(changes).toEqual(['queued', 'running', 'completed']);
  });

  test('stops when the caller aborts, leaving the job alone', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('running')];
    const controller = new AbortController();
    gateway.onGet = () => controller.abort();

    await expect(
      waitForJob(gateway, 'job-1', { sleep: instant, signal: controller.signal })
    ).rejects.toThrow();
    // Waiting is not cancelling; the executor was never asked to stop.
    expect(gateway.cancelled).toEqual([]);
  });

  test('an already-aborted signal stops before the first call', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('running')];

    await expect(
      waitForJob(gateway, 'job-1', { sleep: instant, signal: AbortSignal.abort() })
    ).rejects.toThrow();
    expect(gateway.calls).toEqual([]);
  });
});

describe('waitForJob and a wobbling executor', () => {
  // Observed for real: merging a PR deployed the Worker while a job was running,
  // and the next poll answered 500 "Durable Object reset because its code was
  // updated". The job was fine — it runs in a container and is re-adopted — but
  // the client watching it died.
  test('keeps polling through a transient failure', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('running'), state('completed')];
    gateway.onGet = (attempt) => {
      if (attempt === 1) throw new ExecutorError('Durable Object reset', 500);
    };

    const seen: Array<{ status: number | undefined }> = [];
    const job = await waitForJob(gateway, 'job-1', {
      sleep: instant,
      onTransientError: (error) => seen.push({ status: error.status }),
    });

    expect(job.status).toBe('completed');
    expect(seen).toEqual([{ status: 500 }]);
  });

  test('gives up after enough consecutive failures, and throws the last one', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('running')];
    gateway.onGet = () => {
      throw new ExecutorError('still broken', 503);
    };

    await expect(
      waitForJob(gateway, 'job-1', { sleep: instant, maxConsecutiveErrors: 3 })
    ).rejects.toThrow(/still broken/);
  });

  test('a rate limit is worth waiting out', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('completed')];
    gateway.onGet = (attempt) => {
      if (attempt === 0) throw new ExecutorError('slow down', 429);
    };

    expect((await waitForJob(gateway, 'job-1', { sleep: instant })).status).toBe('completed');
  });

  // A bad token or an unknown job will not get better by asking again.
  test.each([401, 403, 404, 400])('does not retry %d', async (status) => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('running')];
    gateway.onGet = () => {
      throw new ExecutorError('no', status);
    };

    await expect(waitForJob(gateway, 'job-1', { sleep: instant })).rejects.toMatchObject({ status });
  });

  // Logs are reporting on the job, and a problem with reporting must never
  // decide whether the caller sees the job finish.
  test('a failing log read does not stop the wait', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [state('completed')];
    // Assigned on the instance so it shadows the method; spreading the object
    // would drop everything that lives on the prototype.
    gateway.logs = async () => {
      throw new ExecutorError('logs are down', 500);
    };

    const job = await waitForJob(gateway, 'job-1', { sleep: instant, onLog: () => {} });

    expect(job.status).toBe('completed');
  });
});
