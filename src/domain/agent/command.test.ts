import { describe, expect, test } from 'vitest';
import { shellQuote } from '../shell/quote';
import { buildClaudeCommand, unsetForeignCredentials } from './command';

const subscription = { prompt: 'hello', scheme: 'subscription' as const };

describe('unsetForeignCredentials', () => {
  test('a subscription run clears the API-key variables', () => {
    expect(unsetForeignCredentials('subscription')).toBe(
      'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;'
    );
  });

  /**
   * The mirror of the case above, and the reason this is a function rather than
   * a constant string: unsetting `ANTHROPIC_API_KEY` under the API-key scheme
   * would clear the credential the run is supposed to use, and `claude` would
   * fail with "no authentication" on a deployment that is correctly configured.
   */
  test('an API-key run clears the subscription variables, and keeps the key', () => {
    const unset = unsetForeignCredentials('api-key');
    expect(unset).toBe('unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN;');
    expect(unset).not.toContain('ANTHROPIC_API_KEY ');
  });
});

describe('buildClaudeCommand', () => {
  test('unsets the other scheme’s variables before invoking claude', () => {
    expect(buildClaudeCommand(subscription)).toMatch(
      /^unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;/
    );
    expect(buildClaudeCommand({ prompt: 'hello', scheme: 'api-key' })).toMatch(
      /^unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN;/
    );
  });

  test('always pairs stream-json output with --verbose', () => {
    const command = buildClaudeCommand(subscription);
    expect(command).toContain('--output-format stream-json');
    expect(command).toContain('--verbose');
  });

  test('runs with permissions bypassed', () => {
    expect(buildClaudeCommand(subscription)).toContain('--permission-mode bypassPermissions');
  });

  test('shell-quotes the prompt', () => {
    const prompt = "hi; $(rm -rf /)'";
    expect(buildClaudeCommand({ ...subscription, prompt })).toContain(shellQuote(prompt));
  });

  test('omits --resume when there is no resume id', () => {
    expect(buildClaudeCommand(subscription)).not.toContain('--resume');
  });

  test('shell-quotes and appends the resume id when present', () => {
    const command = buildClaudeCommand({ ...subscription, resumeId: "abc'; echo pwned" });
    expect(command).toContain('--resume');
    expect(command).toContain(shellQuote("abc'; echo pwned"));
  });

  // No --model is Claude Code's own default, which moves as models are released.
  test('omits --model when none was chosen', () => {
    expect(buildClaudeCommand(subscription)).not.toContain('--model');
  });

  test('shell-quotes and passes the chosen model', () => {
    const command = buildClaudeCommand({ ...subscription, model: 'claude-opus-4-5' });
    expect(command).toContain(`--model ${shellQuote('claude-opus-4-5')}`);
  });

  test('a model that reached this far is still quoted rather than trusted', () => {
    const command = buildClaudeCommand({ ...subscription, model: "opus'; echo pwned" });
    expect(command).toContain(shellQuote("opus'; echo pwned"));
  });
});
