import { describe, expect, test } from 'vitest';
import type { Env } from './env';
import { parseAllowedHosts } from './config';

const env = (overrides: Partial<Env> = {}): Partial<Env> => overrides;

describe('parseAllowedHosts', () => {
  test('has a default list, and the agent cannot work without Anthropic', () => {
    const hosts = parseAllowedHosts(env());
    expect(hosts).toContain('github.com');
    expect(hosts).toContain('api.anthropic.com');
  });

  test('a configured list replaces the default', () => {
    expect(parseAllowedHosts(env({ SANDBOX_ALLOWED_HOSTS: 'example.com, other.test' }))).toEqual([
      'example.com',
      'other.test',
      'api.anthropic.com',
    ]);
  });

  // Nothing works without it, so it is not a choice.
  test('adds Anthropic back when a configured list leaves it out', () => {
    expect(parseAllowedHosts(env({ SANDBOX_ALLOWED_HOSTS: 'example.com' }))).toContain(
      'api.anthropic.com'
    );
  });

  // A deployment that keeps workspaces uploads them from the container to its
  // own R2 endpoint. Requiring that hole to be opened separately is how the
  // first upload failed with a 520 from a host nobody had allowed.
  test("opens the deployment's own R2 endpoint when it keeps workspaces", () => {
    expect(parseAllowedHosts(env({ CLOUDFLARE_ACCOUNT_ID: 'acc123' }))).toContain(
      'acc123.r2.cloudflarestorage.com'
    );
  });

  test('adds nothing when the deployment has no account to upload to', () => {
    expect(parseAllowedHosts(env()).some((host) => host.includes('r2.cloudflarestorage'))).toBe(
      false
    );
  });

  test('leaves an explicitly configured R2 host alone', () => {
    const hosts = parseAllowedHosts(
      env({ CLOUDFLARE_ACCOUNT_ID: 'acc123', SANDBOX_ALLOWED_HOSTS: 'other.r2.cloudflarestorage.com' })
    );
    expect(hosts.filter((host) => host.endsWith('.r2.cloudflarestorage.com'))).toEqual([
      'other.r2.cloudflarestorage.com',
    ]);
  });
});
