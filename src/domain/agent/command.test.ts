import { describe, expect, test } from 'vitest';
import { shellQuote } from '../shell/quote';
import { buildClaudeCommand } from './command';

describe('buildClaudeCommand', () => {
  test('unsets the ambient Anthropic variables before invoking claude', () => {
    const command = buildClaudeCommand('hello', null);
    expect(command).toMatch(/^unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;/);
  });

  test('always pairs stream-json output with --verbose', () => {
    const command = buildClaudeCommand('hello', null);
    expect(command).toContain('--output-format stream-json');
    expect(command).toContain('--verbose');
  });

  test('runs with permissions bypassed', () => {
    const command = buildClaudeCommand('hello', null);
    expect(command).toContain('--permission-mode bypassPermissions');
  });

  test('shell-quotes the prompt', () => {
    const command = buildClaudeCommand("hi; $(rm -rf /)'", null);
    expect(command).toContain(shellQuote("hi; $(rm -rf /)'"));
  });

  test('omits --resume when there is no resume id', () => {
    const command = buildClaudeCommand('hello', null);
    expect(command).not.toContain('--resume');
  });

  test('shell-quotes and appends the resume id when present', () => {
    const command = buildClaudeCommand('hello', "abc'; echo pwned");
    expect(command).toContain('--resume');
    expect(command).toContain(shellQuote("abc'; echo pwned"));
  });
});
