import { Refusal } from '../../domain/job/errors';
import type { ContinueRequest } from '../../application/job-service';
import type { JobRequest } from '../../domain/job/record';
import type { Env } from '../../infrastructure/env';
import { streamOutput } from './output-stream';
import { authorize } from './auth';

/**
 * What this layer cannot do for itself.
 *
 * The auth probe runs a real prompt in a real sandbox, so it lives in the
 * infrastructure. Passing it in rather than importing it keeps the arrows
 * pointing inward (ADR 0008) — and is how this file came to have tests: the
 * import dragged the container SDK in with it, which does not load outside
 * workerd, which meant the layer deciding who gets in could not be exercised.
 */
export interface RouteDeps {
  probeClaudeAuth: (env: Env) => Promise<Response>;
}

/**
 * The HTTP surface.
 *
 * Nothing is decided here. This layer turns a request into a call on the
 * executor and a result into JSON with a status code, and that is deliberately
 * all it does — the rules live in `src/domain`, the orchestration in
 * `src/application`.
 */
export async function route(request: Request, env: Env, deps: RouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  // Liveness probe stays unauthenticated so uptime checks work; it reveals
  // nothing beyond "the Worker is up".
  if (path === '/health' && method === 'GET') {
    return Response.json({ ok: true, service: 'remote-claude' });
  }

  const denied = authorize(request, env);
  if (denied) return denied;

  const jobs = env.JOBS.get(env.JOBS.idFromName('global'));

  if (path === '/jobs' && method === 'POST') {
    const body = await readJson<JobRequest>(request);
    const record = await jobs.createJob(body);
    // The whole record, not three fields of it: a caller that has just created
    // something should not have to fetch it to learn what it created. `jobId` is
    // kept alongside `id` because that is what this response has always named it,
    // and consumers read it.
    return Response.json({ ...record, jobId: record.id }, { status: 202 });
  }

  if (path === '/jobs' && method === 'GET') {
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
    // `summary=1` omits each job's captured step output — kilobytes per row that
    // a list never renders. The CLI keeps the full shape it expects.
    const list =
      url.searchParams.get('summary') === '1'
        ? await jobs.listJobSummaries(limit)
        : await jobs.listJobs(limit);
    // Two names for one array: `jobs` is what these are called everywhere else,
    // `tasks` is what this endpoint answered with before the rename and what
    // existing clients still read. Removing it would break them for nothing.
    return Response.json({ jobs: list, tasks: list });
  }

  // What this deployment has allocated and whether it got it back. Exists
  // because no external metric can answer that: the container platform reports
  // provisioned capacity, not running instances.
  if (path === '/sandboxes' && method === 'GET') {
    return Response.json(await jobs.listSandboxes());
  }

  if (path === '/health/auth' && method === 'GET') {
    return await deps.probeClaudeAuth(env);
  }

  const match =
    /^\/jobs\/([A-Za-z0-9-]+)(\/logs|\/diff|\/cancel|\/continue|\/output|\/output\/stream)?$/.exec(
      path,
    );
  if (match) {
    const [, id, suffix] = match;
    const jobId = id as string;

    if (!suffix && method === 'GET') {
      const record = await jobs.getJob(jobId);
      return record ? Response.json(record) : notFound();
    }

    if (suffix === '/logs' && method === 'GET') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
      const lines = await jobs.getLogs(jobId, since);
      if (url.searchParams.get('format') === 'text') {
        const text = lines.map((line) => `[${line.stream}] ${line.line}`).join('\n');
        return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      return Response.json({ logs: lines, nextSince: lines.at(-1)?.seq ?? since });
    }

    // What the commands printed, as they printed it. The parsed log says where a
    // run is up to; this says what is happening (ADR 0012).
    if (suffix === '/output' && method === 'GET') {
      const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
      const limit = Math.min(
        Number.parseInt(url.searchParams.get('limit') ?? '65536', 10) || 65_536,
        1_000_000,
      );
      return Response.json(await jobs.readOutput(jobId, offset, limit));
    }

    if (suffix === '/output/stream' && method === 'GET') {
      const raw = url.searchParams.get('offset');
      return streamOutput(
        {
          readOutput: (id, offset, limit) => jobs.readOutput(id, offset, limit),
          status: async (id) => (await jobs.getJob(id))?.status ?? null,
        },
        jobId,
        {
          // Absent means "wherever a late reader should start"; the stream decides
          // that and says so, rather than this deciding it twice.
          ...(raw === null ? {} : { offset: Number.parseInt(raw, 10) || 0 }),
          signal: request.signal,
        },
      );
    }

    if (suffix === '/diff' && method === 'GET') {
      const patch = await jobs.getPatch(jobId);
      if (patch === null) return notFound();
      return new Response(patch, { headers: { 'content-type': 'text/x-patch; charset=utf-8' } });
    }

    // A follow-up turn on a finished job: same branch, same workspace, same
    // conversation (ADR 0011). What it may say for itself is a prompt and the
    // job options; everything else is inherited, so it cannot drift from the
    // job it continues.
    if (suffix === '/continue' && method === 'POST') {
      const body = await readJson<ContinueRequest>(request);
      const created = await jobs.continueJob(jobId, body);
      return Response.json({ ...created, jobId: created.id }, { status: 202 });
    }

    if (suffix === '/cancel' && method === 'POST') {
      const record = await jobs.cancelJob(jobId);
      return record ? Response.json({ jobId: record.id, status: record.status }) : notFound();
    }
  }

  return notFound();
}

function notFound(): Response {
  return Response.json({ error: 'not found' }, { status: 404 });
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Refusal('content-type must be application/json');
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new Refusal('invalid JSON body');
  }
}
