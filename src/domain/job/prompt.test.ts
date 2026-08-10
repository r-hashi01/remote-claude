import { describe, expect, test } from 'vitest';
import { MAX_PROMPT_LENGTH, normalisePrompt } from './prompt';

describe('normalisePrompt', () => {
  test('trims surrounding whitespace', () => {
    expect(normalisePrompt('  fix the flaky test \n')).toBe('fix the flaky test');
  });

  test('rejects a prompt that is missing or only whitespace', () => {
    expect(() => normalisePrompt(undefined)).toThrow(/prompt is required/);
    expect(() => normalisePrompt('   ')).toThrow(/prompt is required/);
  });

  test('rejects a prompt past the cap, and says what the cap is', () => {
    expect(() => normalisePrompt('x'.repeat(MAX_PROMPT_LENGTH + 1))).toThrow(
      new RegExp(`exceeds ${MAX_PROMPT_LENGTH} characters`)
    );
  });

  test('accepts a prompt exactly at the cap', () => {
    const prompt = 'x'.repeat(MAX_PROMPT_LENGTH);
    expect(normalisePrompt(prompt)).toHaveLength(MAX_PROMPT_LENGTH);
  });

  // The cap is measured after trimming: a prompt padded past the limit with
  // whitespace is not an over-long prompt.
  test('measures the cap after trimming', () => {
    expect(normalisePrompt(`${'x'.repeat(MAX_PROMPT_LENGTH)}   `)).toHaveLength(MAX_PROMPT_LENGTH);
  });
});
