import { describe, expect, test } from 'vitest';
import { createRedactor, patternOnlyRedactor } from './redactor';

/**
 * Everything that can reach persisted logs, the HTTP API or an error message
 * passes through a redactor. It had no tests, which for the one component whose
 * failure mode is "a credential is published" is the wrong way round.
 */

describe('literal masking', () => {
  const redact = createRedactor(['super-secret-token-value', undefined, 'short']);

  test('masks a known secret wherever it appears', () => {
    expect(redact('using super-secret-token-value twice: super-secret-token-value')).toBe(
      'using [redacted] twice: [redacted]'
    );
  });

  test('leaves everything else alone', () => {
    expect(redact('nothing to see here')).toBe('nothing to see here');
  });

  // Masking a three-character value would corrupt unrelated output without
  // protecting anything.
  test('ignores values too short to be a credential', () => {
    expect(redact('shorthand')).toBe('shorthand');
  });

  test('a token containing another token still masks completely', () => {
    const redactBoth = createRedactor(['abcdefgh', 'abcdefgh-ijklmnop']);
    expect(redactBoth('value abcdefgh-ijklmnop end')).toBe('value [redacted] end');
  });

  test('an empty string is returned untouched', () => {
    expect(redact('')).toBe('');
  });
});

describe('pattern masking', () => {
  // This layer exists for credentials the Worker never knew about — a token the
  // agent printed out of a file it read, for instance.
  test.each([
    ['an Anthropic key', 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA here'],
    ['a GitHub token', 'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA here'],
    ['a GitHub App installation token in a URL', 'https://x-access-token:ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/o/r'],
    ['a bearer header', 'Authorization: Bearer abcdefghijklmnop'],
    ['a basic header', 'authorization: basic YWJjZGVmZ2hpamts'],
  ])('masks %s', (_label, line) => {
    const out = patternOnlyRedactor(line);
    expect(out).toContain('[redacted');
    expect(out).not.toMatch(/ghp_A|ghs_A|sk-ant-api03-A|abcdefghijklmnop|YWJjZGVmZ2hpamts/);
  });

  test('does not mangle ordinary output', () => {
    const line = 'npm test passed in 12s (github.com/o/r@main)';
    expect(patternOnlyRedactor(line)).toBe(line);
  });
});
