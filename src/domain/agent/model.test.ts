import { describe, expect, test } from 'vitest';
import { REFUSAL } from '../job/errors';
import { normaliseModel } from './model';

describe('normaliseModel', () => {
  test.each([
    'opus',
    'sonnet',
    'haiku',
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-3-5-haiku-20241022',
    // Provider-qualified ids carry dots and a colon.
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    // Long-context variants are spelled with brackets.
    'claude-opus-4-5[1m]',
  ])('accepts %s', (model) => {
    expect(normaliseModel(model)).toBe(model);
  });

  test('trims, because a copied name arrives with whitespace', () => {
    expect(normaliseModel('  opus  ')).toBe('opus');
  });

  // Not the same as `commands`, where empty means skip.
  test('nothing given, and blank, both leave the choice to whoever is next', () => {
    expect(normaliseModel(undefined)).toBeUndefined();
    expect(normaliseModel('')).toBeUndefined();
    expect(normaliseModel('   ')).toBeUndefined();
  });

  /**
   * Refused here rather than in the container. The alternative is a job that
   * allocates a sandbox, clones a repository, installs dependencies and then
   * fails at the agent step — twenty seconds of somebody's time and a container
   * for a mistake visible in the request.
   */
  test.each([
    'the fast one please',
    '../../etc/passwd',
    "opus'; rm -rf /",
    'opus && echo pwned',
    '-not-a-flag',
    'a'.repeat(101),
  ])('refuses %s', (model) => {
    expect(() => normaliseModel(model)).toThrow(expect.objectContaining({ name: REFUSAL }));
  });

  test('the refusal says what a model name looks like', () => {
    expect(() => normaliseModel('the fast one')).toThrow(/alias|model id/);
  });
});
