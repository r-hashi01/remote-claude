import type { Env } from '../../infrastructure/env';

/**
 * Shared-secret bearer auth.
 *
 * This is the last line of defence, not the only one — put the Worker behind
 * Cloudflare Access as well (see README). A missing secret fails closed: the API
 * is never reachable without authentication.
 */
export function authorize(request: Request, env: Env): Response | null {
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
