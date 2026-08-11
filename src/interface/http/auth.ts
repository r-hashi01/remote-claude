import type { Env } from '../../infrastructure/env';

/**
 * Shared-secret bearer auth.
 *
 * This is the last line of defence, not the only one — put the Worker behind
 * Cloudflare Access as well (see docs/operating.md). A missing secret fails
 * closed: the API is never reachable without authentication.
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
  if (!presented || !constantTimeEqual(presented, expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

/**
 * Compare two secrets without letting the time taken say how much matched.
 *
 * Uses the runtime's own primitive where there is one — workerd has
 * `crypto.subtle.timingSafeEqual` — and accumulates the difference by hand
 * elsewhere. The fallback is what makes this function testable at all: without
 * it, the layer that decides whether a request is allowed in could only run
 * inside workerd, and so it was never exercised while every layer behind it was.
 *
 * Length is compared first and returns early. That is not a leak worth closing:
 * the length of a bearer token is not the secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;

  const subtle = crypto.subtle as {
    timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(left, right);
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}
