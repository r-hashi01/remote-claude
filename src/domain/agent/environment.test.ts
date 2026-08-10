import { describe, expect, test } from 'vitest';
import { claudeProcessEnvironment } from './environment';

describe('claudeProcessEnvironment', () => {
  test('always unsets the ambient Anthropic variables', () => {
    for (const options of [
      { authMode: 'proxy' as const, oauthToken: 'real-token', ci: false },
      { authMode: 'direct' as const, oauthToken: 'real-token', ci: true },
    ]) {
      const env = claudeProcessEnvironment(options);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect('ANTHROPIC_API_KEY' in env).toBe(true);
      expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(true);
      expect('ANTHROPIC_BASE_URL' in env).toBe(true);
    }
  });

  test('proxy mode uses the sentinel and never surfaces the real token', () => {
    const env = claudeProcessEnvironment({
      authMode: 'proxy',
      oauthToken: 'sk-ant-super-secret',
      ci: false,
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('proxy-injected');
    // ADR 0002: the real token must not enter the container in proxy mode.
    expect(Object.values(env)).not.toContain('sk-ant-super-secret');
  });

  test('direct mode passes the real token through', () => {
    const env = claudeProcessEnvironment({
      authMode: 'direct',
      oauthToken: 'sk-ant-super-secret',
      ci: false,
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-super-secret');
  });

  test('direct mode with no token configured unsets it', () => {
    const env = claudeProcessEnvironment({
      authMode: 'direct',
      oauthToken: undefined,
      ci: false,
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(true);
  });

  test('sandbox marker is always set', () => {
    const env = claudeProcessEnvironment({ authMode: 'proxy', oauthToken: undefined, ci: false });
    expect(env.IS_SANDBOX).toBe('1');
  });

  test('CI is set only when requested, and omitted entirely otherwise', () => {
    const withCi = claudeProcessEnvironment({ authMode: 'proxy', oauthToken: undefined, ci: true });
    expect(withCi.CI).toBe('1');

    const withoutCi = claudeProcessEnvironment({
      authMode: 'proxy',
      oauthToken: undefined,
      ci: false,
    });
    expect('CI' in withoutCi).toBe(false);
  });
});
