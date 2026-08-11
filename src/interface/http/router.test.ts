import { describe, expect, test } from 'vitest';
import type { Env } from '../../infrastructure/env';
import { route } from './router';

/** The probe talks to a real sandbox; here it only has to answer. */
const deps = { probeClaudeAuth: async () => Response.json({ ok: true, probed: true }) };

const RECORD = {
  id: 'job-1',
  status: 'queued',
  prompt: 'fix the build',
  repo: 'https://github.com/o/r.git',
  baseBranch: 'main',
  branch: 'claude/job-1',
  createdAt: 0,
  options: { skipChecks: false, keepSandbox: false, push: false },
};

/**
 * The Durable Object, as the router sees it: a set of methods.
 *
 * Enough to pin the shape of the answers, which is what consumers depend on and
 * what nothing was checking.
 */
function env(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const stub = new Proxy(
    {},
    {
      get: (_target, method: string) => {
        if (method in overrides) return overrides[method];
        return async (...args: unknown[]) => {
          calls.push({ method, args });
          return RECORD;
        };
      },
    }
  );
  return {
    calls,
    env: {
      REMOTE_CLAUDE_TOKEN: 'right',
      JOBS: { idFromName: () => 'one', get: () => stub },
    } as unknown as Env,
  };
}

const route2 = (request: Request, env: Env) => route(request, env, deps);

const post = (path: string, body?: unknown) =>
  new Request(`https://rc.test${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer right',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = (path: string, token = 'right') =>
  new Request(`https://rc.test${path}`, { headers: { authorization: `Bearer ${token}` } });

describe('what needs a token', () => {
  test('the liveness probe does not', async () => {
    const answer = await route2(new Request('https://rc.test/health'), env().env);
    expect(answer.status).toBe(200);
    await expect(answer.json()).resolves.toMatchObject({ ok: true, service: 'remote-claude' });
  });

  test('everything else does', async () => {
    const answer = await route2(new Request('https://rc.test/jobs'), env().env);
    expect(answer.status).toBe(401);
  });

  test('a wrong token is refused before the job layer is touched', async () => {
    const { env: fake, calls } = env();
    const answer = await route2(get('/jobs', 'wrong'), fake);

    expect(answer.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('starting a job', () => {
  test('answers 202 with the whole record, under both names for the id', async () => {
    const answer = await route2(post('/jobs', { prompt: 'fix the build' }), env().env);

    expect(answer.status).toBe(202);
    // `jobId` is what this endpoint has always called it; `id` is what every
    // other endpoint calls it. Removing either would break somebody.
    await expect(answer.json()).resolves.toMatchObject({ id: 'job-1', jobId: 'job-1', prompt: 'fix the build' });
  });

  // Thrown rather than answered: the entry point maps it. What matters is that
  // it is a Refusal, because that is now what makes it a 400 — replacing the
  // old keyword matching had quietly turned three caller mistakes into 500s,
  // and this test is what noticed.
  test.each([
    [
      'a body that is not declared JSON',
      new Request('https://rc.test/jobs', {
        method: 'POST',
        headers: { authorization: 'Bearer right' },
        body: '{"prompt":"x"}',
      }),
      /content-type/,
    ],
    [
      'a body that is not JSON at all',
      new Request('https://rc.test/jobs', {
        method: 'POST',
        headers: { authorization: 'Bearer right', 'content-type': 'application/json' },
        body: 'not json',
      }),
      /invalid JSON/,
    ],
  ])('refuses %s', async (_label, request, expected) => {
    await expect(route2(request, env().env)).rejects.toMatchObject({
      name: 'Refusal',
      message: expect.stringMatching(expected),
    });
  });
});

describe('listing jobs', () => {
  test('answers under both `jobs` and `tasks`, with the same array', async () => {
    const { env: fake } = env({ listJobSummaries: async () => [RECORD] });
    const body = (await (await route2(get('/jobs?limit=5&summary=1'), fake)).json()) as {
      jobs: unknown[];
      tasks: unknown[];
    };

    expect(body.jobs).toEqual([RECORD]);
    expect(body.tasks).toEqual(body.jobs);
  });

  test('summary=1 asks for the projection, and its absence asks for the records', async () => {
    const summaries = { called: false };
    const full = { called: false };
    const { env: fake } = env({
      listJobSummaries: async () => ((summaries.called = true), []),
      listJobs: async () => ((full.called = true), []),
    });

    await route2(get('/jobs?summary=1'), fake);
    expect(summaries.called).toBe(true);

    await route2(get('/jobs'), fake);
    expect(full.called).toBe(true);
  });
});

describe('one job', () => {
  test('is 404 when the executor does not know it', async () => {
    const { env: fake } = env({ getJob: async () => null });
    expect((await route2(get('/jobs/nope'), fake)).status).toBe(404);
  });

  test('serves the patch as a patch', async () => {
    const { env: fake } = env({ getPatch: async () => 'diff --git a b\n' });
    const answer = await route2(get('/jobs/job-1/diff'), fake);

    expect(answer.headers.get('content-type')).toContain('text/x-patch');
    await expect(answer.text()).resolves.toBe('diff --git a b\n');
  });

  test('a job with no patch yet is 404, not an empty patch', async () => {
    const { env: fake } = env({ getPatch: async () => null });
    expect((await route2(get('/jobs/job-1/diff'), fake)).status).toBe(404);
  });

  test('logs come back with where to continue from', async () => {
    const lines = [{ seq: 7, ts: 1, stream: 'stdout', line: 'hello' }];
    const { env: fake } = env({ getLogs: async () => lines });

    await expect((await route2(get('/jobs/job-1/logs?since=3'), fake)).json()).resolves.toEqual({
      logs: lines,
      nextSince: 7,
    });
  });

  test('logs can be plain text for a terminal', async () => {
    const { env: fake } = env({
      getLogs: async () => [{ seq: 1, ts: 1, stream: 'system', line: 'started' }],
    });
    const answer = await route2(get('/jobs/job-1/logs?format=text'), fake);

    expect(answer.headers.get('content-type')).toContain('text/plain');
    await expect(answer.text()).resolves.toBe('[system] started');
  });

  test('continuing one posts to the job it continues', async () => {
    const { env: fake, calls } = env();
    const answer = await route2(post('/jobs/job-1/continue', { prompt: 'and now the other way' }), fake);

    expect(answer.status).toBe(202);
    expect(calls[0]).toEqual({
      method: 'continueJob',
      args: ['job-1', { prompt: 'and now the other way' }],
    });
  });
});

describe('what is not there', () => {
  test.each(['/', '/jobs/job-1/unknown', '/nope'])('%s is 404', async (path) => {
    expect((await route2(get(path), env().env)).status).toBe(404);
  });
});
