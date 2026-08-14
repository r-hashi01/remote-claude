import { describe, expect, test } from 'vitest';
import { claudeCredential, describeScheme } from './credential';

describe('claudeCredential', () => {
  test('an OAuth token alone means the subscription scheme', () => {
    expect(claudeCredential({ oauthToken: 'sk-ant-oat-x' })).toEqual({ scheme: 'subscription' });
  });

  test('an API key alone means the API scheme', () => {
    expect(claudeCredential({ apiKey: 'sk-ant-api03-x' })).toEqual({ scheme: 'api-key' });
  });

  /**
   * The whole reason the scheme is derived rather than flagged: a flag saying
   * "api-key" beside a deployment holding only an OAuth token is a request
   * signed with the wrong credential, and the 401 that comes back says nothing
   * about a flag.
   */
  test('nothing configured is a problem rather than a default', () => {
    const credential = claudeCredential({});
    expect(credential.problem).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(credential.problem).toContain('ANTHROPIC_API_KEY');
  });

  // Which account pays is not something to guess at.
  test('both configured is a problem, and says which two', () => {
    const credential = claudeCredential({ oauthToken: 'sk-ant-oat-x', apiKey: 'sk-ant-api03-x' });
    expect(credential.problem).toContain('both');
    expect(credential.problem).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(credential.problem).toContain('ANTHROPIC_API_KEY');
  });

  // `wrangler secret put` with an empty value, or a var left blank in
  // .dev.vars, is somebody who has not configured it.
  test('a blank secret is not a credential', () => {
    expect(claudeCredential({ oauthToken: '   ' }).problem).toBeDefined();
    expect(claudeCredential({ oauthToken: '   ', apiKey: 'sk-ant-api03-x' })).toEqual({
      scheme: 'api-key',
    });
  });

  test('a problem still names a scheme, so a command line can be built', () => {
    expect(claudeCredential({}).scheme).toBe('subscription');
  });
});

describe('describeScheme', () => {
  test('names the credential rather than the mode', () => {
    expect(describeScheme('subscription')).toBe('subscription-oauth');
    expect(describeScheme('api-key')).toBe('anthropic-api-key');
  });
});
