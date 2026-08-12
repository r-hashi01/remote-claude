import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

/**
 * The hop the request makes, made in a test.
 *
 * Everything else in this repository tests the service directly, and that is why
 * a refusal thrown inside the JobManager Durable Object was answered 500 in
 * production while every test passed: RPC rebuilds an error from its name,
 * message and stack rather than its class, so `instanceof Refusal` was false on
 * the far side. 500 also means "worth retrying" to any client following the
 * SDK's rule, so a permanent refusal was something consumers would retry until
 * they gave up.
 *
 * These go through `SELF`, so they cross the boundary rather than reason about
 * it. Deliberately few: what is being pinned is the platform's behaviour, not the
 * application's, and the application has 329 tests that run in a second.
 */
const auth = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

describe('a refusal raised inside a Durable Object', () => {
  it('reaches the caller as 400, not 500', async () => {
    // `prompt is required` is raised by the service, which runs inside the object.
    const response = await SELF.fetch('https://executor/jobs', {
      method: 'POST',
      headers: auth,
      body: '{}',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'prompt is required' });
  });

  it('keeps saying which repository it will not run against', async () => {
    const response = await SELF.fetch('https://executor/jobs', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ prompt: 'x', repo: 'https://github.com/other/thing.git' }),
    });

    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toMatch(/other\/thing/);
  });
});

describe('a NotFound raised inside a Durable Object', () => {
  it('reaches the caller as 404', async () => {
    const response = await SELF.fetch('https://executor/jobs/no-such-job/continue', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ prompt: 'carry on' }),
    });

    expect(response.status).toBe(404);
  });
});

describe('the auth check, in the runtime that has the primitive', () => {
  // `crypto.subtle.timingSafeEqual` exists here and not in node. The fallback is
  // what the node suite exercises; this is the path production takes.
  it('refuses a token that does not match', async () => {
    const response = await SELF.fetch('https://executor/jobs', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(response.status).toBe(401);
  });

  it('accepts the one that does', async () => {
    const response = await SELF.fetch('https://executor/jobs', { headers: auth });
    expect(response.status).toBe(200);
  });
});
