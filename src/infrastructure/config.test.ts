import { describe, expect, test } from 'vitest';
import type { Env } from './env';
import { loadConfig, parseAllowedHosts } from './config';

const env = (overrides: Partial<Env> = {}): Partial<Env> => overrides;

/** Enough of an environment to load: the rest of `Env` is bindings. */
const config = (overrides: Partial<Env> = {}) =>
  loadConfig({ REPO_URL: 'https://github.com/o/r.git', DEFAULT_BASE_BRANCH: 'main', ...overrides } as Env);

describe('which credential the deployment authenticates with', () => {
  test('a subscription token means the subscription scheme', () => {
    const loaded = config({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' });
    expect(loaded.claudeAuthScheme).toBe('subscription');
    expect(loaded.claudeCredentialProblem).toBeUndefined();
  });

  test('an API key means the API scheme', () => {
    const loaded = config({ ANTHROPIC_API_KEY: 'sk-ant-api03-x' });
    expect(loaded.claudeAuthScheme).toBe('api-key');
    expect(loaded.claudeCredentialProblem).toBeUndefined();
  });

  /**
   * Carried rather than thrown. This is loaded in Durable Object constructors,
   * and a deployment that has not been given a credential should still answer
   * `GET /jobs` and say what is missing when asked, rather than fail to wake up.
   */
  test('no credential is a problem the deployment carries, not a crash', () => {
    expect(config().claudeCredentialProblem).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  test('two credentials is a problem as well', () => {
    expect(
      config({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x', ANTHROPIC_API_KEY: 'sk-ant-api03-x' })
        .claudeCredentialProblem
    ).toContain('both');
  });
});

describe('the model a deployment runs', () => {
  test('none configured leaves the choice to Claude Code', () => {
    expect(config().model).toBeUndefined();
    expect(config({ CLAUDE_MODEL: '   ' }).model).toBeUndefined();
  });

  // Trimmed and otherwise taken as written: the executor keeps no list of
  // models, so a name it does not recognise is not a name it may reject.
  test('is taken as written, trimmed', () => {
    expect(config({ CLAUDE_MODEL: '  claude-opus-4-5  ' }).model).toBe('claude-opus-4-5');
  });
});

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

  // This used to stop deriving as soon as any R2 host was configured, on the
  // grounds that an explicit list should win. It cost an upload: a list naming one
  // host is not a list that names the two this feature needs, and the missing one
  // is answered by the interception with its own certificate. An explicit entry is
  // kept and added to, never replaced.
  test('keeps an explicitly configured R2 host and still derives its own', () => {
    const hosts = parseAllowedHosts(
      env({ CLOUDFLARE_ACCOUNT_ID: 'acc123', SANDBOX_ALLOWED_HOSTS: 'other.r2.cloudflarestorage.com' })
    );
    expect(hosts).toContain('other.r2.cloudflarestorage.com');
    expect(hosts).toContain('acc123.r2.cloudflarestorage.com');
  });
});

/**
 * Both ways the same bucket can be addressed.
 *
 * A workspace snapshot went up fine and a package cache did not, with "self signed
 * certificate in certificate chain" — which is what the container sees when the
 * interception answers for a host nobody allowed. The difference was size: past a
 * threshold the upload becomes multipart and is addressed to the bucket as a
 * subdomain instead of a path.
 */
describe('the R2 hosts a container may reach', () => {
  const account = '2b7e5c1a9f4d';
  const bucket = 'remote-claude-workspaces';

  test('include both addressing styles', () => {
    const hosts = parseAllowedHosts({
      CLOUDFLARE_ACCOUNT_ID: account,
      BACKUP_BUCKET_NAME: bucket,
    } as never);

    expect(hosts).toContain(`${account}.r2.cloudflarestorage.com`);
    expect(hosts).toContain(`${bucket}.${account}.r2.cloudflarestorage.com`);
  });

  test('stop at the endpoint when no bucket is named', () => {
    const hosts = parseAllowedHosts({ CLOUDFLARE_ACCOUNT_ID: account } as never);

    expect(hosts).toContain(`${account}.r2.cloudflarestorage.com`);
    expect(hosts.filter((host) => host.endsWith('.r2.cloudflarestorage.com'))).toHaveLength(1);
  });

  test('add nothing when the account is unknown', () => {
    const hosts = parseAllowedHosts({ BACKUP_BUCKET_NAME: bucket } as never);

    expect(hosts.some((host) => host.includes('r2.cloudflarestorage.com'))).toBe(false);
  });
});
