import { describe, expect, test } from 'vitest';
import { ExecutorError } from './errors.js';
import { HttpJobGateway } from './http-gateway.js';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that answers from a table and records what it was asked. */
function stub(routes: Record<string, () => Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = Object.keys(routes).find((key) => url.endsWith(key));
    if (!route) return new Response('not found', { status: 404 });
    return routes[route]!();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function gateway(routes: Record<string, () => Response>) {
  const { fetch, calls } = stub(routes);
  return {
    calls,
    subject: new HttpJobGateway(
      { url: 'https://rc.example.workers.dev/', token: 'shhh' },
      { fetchImpl: fetch }
    ),
  };
}

const JOB = {
  id: 'job-1',
  status: 'queued',
  prompt: 'x',
  repo: 'https://github.com/o/r.git',
  baseBranch: 'main',
  branch: 'claude/job-1',
  createdAt: 0,
  options: { skipChecks: false, keepSandbox: false, push: false },
};

describe('authentication and shape', () => {
  test('presents the token as a bearer credential on every authenticated call', async () => {
    const { subject, calls } = gateway({ '/jobs/job-1': () => Response.json(JOB) });

    await subject.get('job-1');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer shhh');
    expect(headers['content-type']).toBe('application/json');
  });

  test('tolerates a trailing slash on the configured URL', async () => {
    const { subject, calls } = gateway({ '/jobs/job-1': () => Response.json(JOB) });

    await subject.get('job-1');

    expect(calls[0]?.url).toBe('https://rc.example.workers.dev/jobs/job-1');
  });

  test('the liveness probe is unauthenticated, because that side does not require it', async () => {
    const { subject, calls } = gateway({ '/health': () => Response.json({ ok: true }) });

    expect(await subject.ping()).toBe(true);
    expect((calls[0]?.init.headers as Record<string, string>)?.authorization).toBeUndefined();
  });
});

describe('creating a job', () => {
  test('posts the request and returns the record', async () => {
    const { subject, calls } = gateway({
      '/jobs': () => Response.json({ ...JOB, jobId: 'job-1' }, { status: 202 }),
    });

    const job = await subject.create({ prompt: 'fix the build' });

    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ prompt: 'fix the build' });
    expect(job.id).toBe('job-1');
  });

  // Older executors name the id `jobId` in this one response.
  test('accepts an executor that only sends jobId', async () => {
    const { subject } = gateway({
      '/jobs': () => Response.json({ jobId: 'job-9', status: 'queued' }, { status: 202 }),
    });

    expect((await subject.create({ prompt: 'x' })).id).toBe('job-9');
  });
});

describe('listing jobs', () => {
  test('reads the modern field name', async () => {
    const { subject } = gateway({ 'summary=1': () => Response.json({ jobs: [JOB] }) });
    expect((await subject.list(20)).map((job) => job.id)).toEqual(['job-1']);
  });

  test('falls back to what older executors called it', async () => {
    const { subject } = gateway({ 'summary=1': () => Response.json({ tasks: [JOB] }) });
    expect((await subject.list(20)).map((job) => job.id)).toEqual(['job-1']);
  });

  test('an executor that sends neither is an empty list, not a crash', async () => {
    const { subject } = gateway({ 'summary=1': () => Response.json({}) });
    expect(await subject.list(20)).toEqual([]);
  });
});

describe('failures', () => {
  test('surfaces the executor’s own message rather than the envelope around it', async () => {
    const { subject } = gateway({
      '/jobs': () =>
        Response.json(
          { error: 'this executor is pinned to https://github.com/o/r.git' },
          { status: 400 }
        ),
    });

    await expect(subject.create({ prompt: 'x' })).rejects.toThrow(/pinned to/);
    await expect(subject.create({ prompt: 'x' })).rejects.toBeInstanceOf(ExecutorError);
  });

  test('carries the status code, so a caller can tell a bad token from a bad request', async () => {
    const { subject } = gateway({ '/jobs/job-1': () => Response.json({ error: 'unauthorized' }, { status: 401 }) });

    await expect(subject.get('job-1')).rejects.toMatchObject({ status: 401 });
  });

  // Cloudflare Access in front of the executor answers with an HTML login page.
  test('does not choke when the body is not JSON', async () => {
    const { subject } = gateway({
      '/jobs/job-1': () => new Response('<html>login</html>', { status: 302 }),
    });

    await expect(subject.get('job-1')).rejects.toThrow(/302/);
  });
});

describe('the diff', () => {
  test('returns the patch as text', async () => {
    const { subject } = gateway({ '/diff': () => new Response('diff --git a b\n') });
    expect(await subject.getDiff('job-1')).toBe('diff --git a b\n');
  });

  test('is null while there is not one, which is not an error', async () => {
    const { subject } = gateway({ '/diff': () => new Response('', { status: 404 }) });
    expect(await subject.getDiff('job-1')).toBeNull();
  });
});

describe('logs', () => {
  test('asks from a sequence number and reports where to continue', async () => {
    const { subject, calls } = gateway({
      'since=7': () => Response.json({ logs: [{ seq: 8, ts: 1, stream: 'stdout', line: 'hi' }], nextSince: 8 }),
    });

    const page = await subject.logs('job-1', 7);

    expect(calls[0]?.url).toContain('since=7');
    expect(page.nextSince).toBe(8);
  });
});
