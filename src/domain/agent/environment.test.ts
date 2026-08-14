import { describe, expect, test } from 'vitest';
import { CLAUDE_CONFIG_DIR, claudeProcessEnvironment } from './environment';

const CREDENTIAL_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

describe('claudeProcessEnvironment', () => {
  /**
   * Every credential variable is named on every path, whichever scheme is in
   * use: the ones this scheme does not use are unset by name rather than left
   * to whatever the image or the platform happens to have set.
   */
  test('names every credential variable, and the base URL, on every path', () => {
    for (const options of [
      { authMode: 'proxy' as const, scheme: 'subscription' as const },
      { authMode: 'direct' as const, scheme: 'subscription' as const },
      { authMode: 'proxy' as const, scheme: 'api-key' as const },
      { authMode: 'direct' as const, scheme: 'api-key' as const },
    ]) {
      const env = claudeProcessEnvironment({
        ...options,
        oauthToken: 'real-token',
        apiKey: 'real-key',
        ci: true,
      });
      for (const name of [...CREDENTIAL_VARIABLES, 'ANTHROPIC_BASE_URL']) {
        expect(name in env, `${name} on ${options.scheme}/${options.authMode}`).toBe(true);
      }
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    }
  });

  test('exactly one credential variable is ever set', () => {
    for (const scheme of ['subscription', 'api-key'] as const) {
      const env = claudeProcessEnvironment({
        authMode: 'direct',
        scheme,
        oauthToken: 'real-token',
        apiKey: 'real-key',
        ci: false,
      });
      const set = CREDENTIAL_VARIABLES.filter((name) => env[name] !== undefined);
      expect(set).toEqual([scheme === 'subscription' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY']);
    }
  });

  test('proxy mode uses the sentinel and never surfaces the real subscription token', () => {
    const env = claudeProcessEnvironment({
      authMode: 'proxy',
      scheme: 'subscription',
      oauthToken: 'sk-ant-super-secret',
      apiKey: undefined,
      ci: false,
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('proxy-injected');
    // ADR 0002: the real token must not enter the container in proxy mode.
    expect(Object.values(env)).not.toContain('sk-ant-super-secret');
  });

  test('proxy mode uses the sentinel and never surfaces the real API key', () => {
    const env = claudeProcessEnvironment({
      authMode: 'proxy',
      scheme: 'api-key',
      oauthToken: undefined,
      apiKey: 'sk-ant-api03-super-secret',
      ci: false,
    });

    expect(env.ANTHROPIC_API_KEY).toBe('proxy-injected');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain('sk-ant-api03-super-secret');
  });

  test('direct mode passes the real credential of the configured scheme through', () => {
    const subscription = claudeProcessEnvironment({
      authMode: 'direct',
      scheme: 'subscription',
      oauthToken: 'sk-ant-oat-secret',
      apiKey: 'sk-ant-api03-secret',
      ci: false,
    });
    expect(subscription.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-secret');
    // The other credential is not "also fine to have around": a container
    // holding both is one where the scheme is decided by Claude Code's
    // precedence rules rather than by this deployment.
    expect(subscription.ANTHROPIC_API_KEY).toBeUndefined();

    const apiKey = claudeProcessEnvironment({
      authMode: 'direct',
      scheme: 'api-key',
      oauthToken: 'sk-ant-oat-secret',
      apiKey: 'sk-ant-api03-secret',
      ci: false,
    });
    expect(apiKey.ANTHROPIC_API_KEY).toBe('sk-ant-api03-secret');
    expect(apiKey.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test('direct mode with no credential configured unsets it', () => {
    const env = claudeProcessEnvironment({
      authMode: 'direct',
      scheme: 'subscription',
      oauthToken: undefined,
      apiKey: undefined,
      ci: false,
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(true);
  });

  test('sandbox marker is always set', () => {
    const env = claudeProcessEnvironment({
      authMode: 'proxy',
      scheme: 'subscription',
      oauthToken: undefined,
      apiKey: undefined,
      ci: false,
    });
    expect(env.IS_SANDBOX).toBe('1');
  });

  // Claude Code keeps conversations in the home directory by default, which is
  // the one place a workspace snapshot cannot carry between sandboxes.
  test('the conversation is kept inside the workspace, so a snapshot holds it', () => {
    const env = claudeProcessEnvironment({
      authMode: 'proxy',
      scheme: 'subscription',
      oauthToken: undefined,
      apiKey: undefined,
      ci: true,
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe(CLAUDE_CONFIG_DIR);
    expect(CLAUDE_CONFIG_DIR.startsWith('/workspace/')).toBe(true);
  });

  test('CI is set only when requested, and omitted entirely otherwise', () => {
    const base = {
      authMode: 'proxy' as const,
      scheme: 'subscription' as const,
      oauthToken: undefined,
      apiKey: undefined,
    };
    expect(claudeProcessEnvironment({ ...base, ci: true }).CI).toBe('1');
    expect('CI' in claudeProcessEnvironment({ ...base, ci: false })).toBe(false);
  });
});
