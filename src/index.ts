import { createRedactor } from './domain/redaction/redactor';
import type { Env } from './infrastructure/env';
import { maskedSecrets } from './infrastructure/secrets';
import { route } from './interface/http/router';

/**
 * The entry point, and nothing else.
 *
 * Layering, outermost first:
 *   interface/      HTTP in, JSON out. Decides nothing.
 *   application/    the use cases, written against ports.
 *   domain/         the rules — jobs, refs, repositories, liveness, redaction.
 *   infrastructure/ the ports implemented: Durable Objects, SQLite, R2, GitHub,
 *                   the container platform.
 *
 * The arrows point inwards: domain imports nothing, application imports domain,
 * infrastructure imports both, and this file is the only place that knows all
 * four exist.
 */

// Durable Object classes referenced from wrangler.jsonc. The names are load
// bearing — migrations are keyed by class name, not by path.
export { Sandbox } from './infrastructure/durable-objects/sandbox';
export { JobManager } from './infrastructure/durable-objects/job-manager';
export { AgentSession } from './infrastructure/durable-objects/agent-session';
// Required by the Sandbox SDK for container routing.
export { ContainerProxy } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const redact = createRedactor(maskedSecrets(env));

    try {
      return await route(request, env);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      // 4xx for caller mistakes, 500 for everything else.
      const status = /required|invalid|must|disabled|exceeds|cannot reach/i.test(message) ? 400 : 500;
      return Response.json({ error: message }, { status });
    }
  },
} satisfies ExportedHandler<Env>;
