/**
 * Where an executor lives.
 *
 * A deployment holds a Claude subscription credential and a GitHub App key, and
 * the bearer token that guards it is sent on every call — so reaching one over
 * plaintext is refused rather than supported quietly. Loopback is the exception:
 * `wrangler dev` serves http on localhost and there is nothing to intercept.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Validate and canonicalise a base URL: no trailing slash, no surprises. */
export function normaliseUrl(url: string): string {
  const trimmed = url.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`the executor URL must be absolute, for example https://example.workers.dev (got "${trimmed}")`);
  }

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname))) {
    throw new Error(`the executor URL must use https (got "${trimmed}")`);
  }

  return trimmed.replace(/\/+$/, '');
}
