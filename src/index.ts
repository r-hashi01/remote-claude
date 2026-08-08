import { ACP_PROTOCOL_VERSION } from './acp';
import { loadConfig } from './config';
import { getSandboxProvider } from './providers';
import { createRedactor, patternOnlyRedactor } from './redact';
import { shellQuote } from './runner';
import type { Env, JobRequest } from './types';

// Durable Object classes referenced from wrangler.jsonc.
export { Sandbox } from './sandbox';
export { JobManager } from './job-manager';
export { AgentSession } from './agent-session';
// Required by the Sandbox SDK for container routing.
export { ContainerProxy } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const redact = createRedactor([
      env.CLAUDE_CODE_OAUTH_TOKEN,
      env.GITHUB_APP_PRIVATE_KEY,
      env.REMOTE_CLAUDE_TOKEN,
      env.R2_ACCESS_KEY_ID,
      env.R2_SECRET_ACCESS_KEY,
    ]);

    try {
      return await route(request, env);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      // 4xx for caller mistakes, 500 for everything else.
      const status = /required|invalid|must|disabled|exceeds/i.test(message) ? 400 : 500;
      return Response.json({ error: message }, { status });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
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
    return Response.json({ jobId: record.id, status: record.status, branch: record.branch }, { status: 202 });
  }

  if (path === '/jobs' && method === 'GET') {
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
    return Response.json({ tasks: await jobs.listJobs(limit) });
  }

  if (path === '/health/auth' && method === 'GET') {
    return await probeClaudeAuth(env);
  }

  // ---- ACP session surface ------------------------------------------
  // The interactive counterpart to /tasks. Sessions are multi-turn and stream
  // ACP `session/update` notifications over SSE; the local bridge turns that
  // into real ACP stdio for an editor.
  if (path === '/acp/sessions' && method === 'POST') {
    return Response.json(
      { sessionId: `s-${crypto.randomUUID()}`, protocolVersion: ACP_PROTOCOL_VERSION },
      { status: 201 }
    );
  }

  const acp = /^\/acp\/sessions\/([A-Za-z0-9-]+)(\/stream|\/prompt|\/cancel)?$/.exec(path);
  if (acp) {
    const [, sessionId, suffix] = acp;
    const session = env.ACP.get(env.ACP.idFromName(sessionId));

    // The DO owns the SSE response so it can write to it as events arrive.
    if (suffix === '/stream' && method === 'GET') return session.fetch(request);

    if (suffix === '/prompt' && method === 'POST') {
      const body = await readJson<{ text?: string }>(request);
      const text = (body.text ?? '').trim();
      if (!text) throw new Error('text is required');
      return Response.json(await session.prompt(sessionId, text), { status: 202 });
    }

    if (suffix === '/cancel' && method === 'POST') {
      await session.cancel();
      return Response.json({ ok: true });
    }

    if (!suffix && method === 'DELETE') {
      await session.close();
      return Response.json({ ok: true });
    }
  }

  const match = /^\/jobs\/([A-Za-z0-9-]+)(\/logs|\/diff|\/cancel)?$/.exec(path);
  if (match) {
    const [, id, suffix] = match;

    if (!suffix && method === 'GET') {
      const record = await jobs.getJob(id);
      return record ? Response.json(record) : notFound();
    }

    if (suffix === '/logs' && method === 'GET') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
      const lines = await jobs.getLogs(id, since);
      if (url.searchParams.get('format') === 'text') {
        const text = lines.map((l) => `[${l.stream}] ${l.line}`).join('\n');
        return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      return Response.json({ logs: lines, nextSince: lines.at(-1)?.seq ?? since });
    }

    if (suffix === '/diff' && method === 'GET') {
      const patch = await jobs.getPatch(id);
      if (patch === null) return notFound();
      return new Response(patch, {
        headers: { 'content-type': 'text/x-patch; charset=utf-8' },
      });
    }

    if (suffix === '/cancel' && method === 'POST') {
      const record = await jobs.cancelJob(id);
      return record ? Response.json({ jobId: record.id, status: record.status }) : notFound();
    }
  }

  return notFound();
}

function notFound(): Response {
  return Response.json({ error: 'not found' }, { status: 404 });
}

/**
 * Shared-secret bearer auth.
 *
 * This is the last line of defence, not the only one — put the Worker behind
 * Cloudflare Access as well (see README). A missing secret fails closed: the
 * API is never reachable without authentication.
 */
function authorize(request: Request, env: Env): Response | null {
  const expected = env.REMOTE_CLAUDE_TOKEN;
  if (!expected) {
    return Response.json(
      { error: 'REMOTE_CLAUDE_TOKEN is not configured; refusing all requests' },
      { status: 503 }
    );
  }

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !timingSafeEqual(presented, expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error('content-type must be application/json');
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error('invalid JSON body');
  }
}

/**
 * End-to-end check that Claude Code authenticates with the subscription OAuth
 * token. Spends a negligible amount of quota, so it is an explicit endpoint
 * rather than part of every task.
 */
async function probeClaudeAuth(env: Env): Promise<Response> {
  const config = loadConfig(env);
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    return Response.json(
      { ok: false, reason: 'CLAUDE_CODE_OAUTH_TOKEN is not configured' },
      { status: 503 }
    );
  }

  const sandbox = await getSandboxProvider(env).create('health-auth', { sleepAfter: '1m' });
  try {
    const probe = await sandbox.exec(
      `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; claude -p ${shellQuote('Reply with exactly: OK')}`,
      {
        cwd: '/workspace',
        timeoutMs: 120_000,
        env: {
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CODE_OAUTH_TOKEN:
            config.claudeAuthMode === 'proxy' ? 'proxy-injected' : env.CLAUDE_CODE_OAUTH_TOKEN,
          IS_SANDBOX: '1',
        },
      }
    );

    return Response.json({
      ok: probe.success,
      authMode: config.claudeAuthMode,
      authScheme: 'subscription-oauth',
      apiKeyInContainer: false,
      // Redact defensively: this is model output.
      output: patternOnlyRedactor((probe.success ? probe.stdout : probe.stderr).trim().slice(0, 500)),
    });
  } finally {
    await sandbox.destroy().catch(() => {});
  }
}
