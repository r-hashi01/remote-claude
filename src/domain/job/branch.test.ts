import { describe, expect, test } from 'vitest';
import { branchForJob, sanitizeRef } from './branch';

describe('sanitizeRef', () => {
  test('accepts ordinary refs', () => {
    expect(sanitizeRef('main')).toBe('main');
    expect(sanitizeRef('release/2026-04.1')).toBe('release/2026-04.1');
    expect(sanitizeRef('  feature/x  ')).toBe('feature/x');
  });

  // These end up interpolated into shell commands in the container, so the
  // character set is deliberately boring.
  test.each([
    ['a ref with a space', 'my branch'],
    ['command substitution', '$(rm -rf /)'],
    ['a quote', "main'"],
    ['a semicolon', 'main; echo hi'],
    ['parent traversal', 'feature/../../etc'],
    ['nothing at all', ''],
    ['something absurdly long', 'a'.repeat(256)],
  ])('rejects %s', (_label, ref) => {
    expect(() => sanitizeRef(ref)).toThrow(/invalid branch name/);
  });
});

describe('branchForJob', () => {
  test('names the branch after the job', () => {
    expect(branchForJob('m8x2k1-ab12cd34')).toBe('claude/m8x2k1-ab12cd34');
  });

  test('produces a ref that survives sanitising', () => {
    const branch = branchForJob('m8x2k1-ab12cd34');
    expect(sanitizeRef(branch)).toBe(branch);
  });
});
