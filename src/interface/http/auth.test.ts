import { describe, expect, test } from 'vitest';
import type { Env } from '../../infrastructure/env';
import { authorize, constantTimeEqual } from './auth';

const env = (token?: string) => ({ REMOTE_CLAUDE_TOKEN: token }) as Env;
const withHeader = (value?: string) =>
  new Request('https://rc.test/jobs', value ? { headers: { authorization: value } } : {});

describe('authorize', () => {
  test('lets a request through when the token matches', () => {
    expect(authorize(withHeader('Bearer right'), env('right'))).toBeNull();
  });

  // The property that matters most, and the one nothing was checking: an
  // executor with no token configured is not open, it is closed.
  test('refuses everything when no token is configured', async () => {
    const denied = authorize(withHeader('Bearer anything'), env(undefined));

    expect(denied?.status).toBe(503);
    await expect(denied?.json()).resolves.toMatchObject({
      error: expect.stringContaining('REMOTE_CLAUDE_TOKEN is not configured'),
    });
  });

  test('refuses everything when the configured token is empty', () => {
    // An empty secret reads as "set" to anything looking at names alone. Three
    // separate features were broken by that this week.
    expect(authorize(withHeader('Bearer '), env(''))?.status).toBe(503);
  });

  test.each([
    ['no header at all', undefined],
    ['the wrong token', 'Bearer wrong'],
    ['a token of a different length', 'Bearer right-but-longer'],
    ['the right token without the scheme', 'right'],
    ['the wrong scheme', 'Basic right'],
    ['a lowercase scheme', 'bearer right'],
    ['an empty bearer', 'Bearer '],
  ])('refuses %s with 401', (_label, header) => {
    expect(authorize(withHeader(header), env('right'))?.status).toBe(401);
  });

  // The reply says nothing about which part was wrong.
  test('says only that it was unauthorized', async () => {
    const denied = authorize(withHeader('Bearer wrong'), env('right'));
    await expect(denied?.json()).resolves.toEqual({ error: 'unauthorized' });
  });
});

describe('constantTimeEqual', () => {
  test('is true only for the same bytes', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });

  test('handles different lengths without throwing', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  test('two empty strings are equal', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });

  // Bytes, not characters. Written as escapes because the point is invisible
  // otherwise: these two look identical in an editor and are not the same bytes.
  test('compares encoded bytes rather than what they look like', () => {
    const composed = '\u00e9'; // é
    const decomposed = 'e\u0301'; // e + combining acute
    expect(composed).not.toBe(decomposed);
    expect(constantTimeEqual(composed, decomposed)).toBe(false);
    expect(constantTimeEqual('\u{1F511}', '\u{1F511}')).toBe(true);
  });
});
