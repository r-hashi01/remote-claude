import { describe, expect, test } from 'vitest';
import { normaliseUrl } from './endpoint.js';

describe('normaliseUrl', () => {
  test('trims whitespace and trailing slashes', () => {
    expect(normaliseUrl('  https://rc.example.workers.dev///  ')).toBe(
      'https://rc.example.workers.dev'
    );
  });

  test('leaves a well-formed URL alone', () => {
    expect(normaliseUrl('https://rc.example.workers.dev')).toBe('https://rc.example.workers.dev');
  });

  // An executor holds a Claude subscription credential and a GitHub App key.
  // Reaching it over plaintext is not a thing to support quietly.
  test('refuses plaintext http, except against a local dev server', () => {
    expect(() => normaliseUrl('http://rc.example.workers.dev')).toThrow(/https/);
    expect(normaliseUrl('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(normaliseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });

  test('refuses something that is not a URL at all', () => {
    expect(() => normaliseUrl('rc.example.workers.dev')).toThrow();
    expect(() => normaliseUrl('')).toThrow();
  });
});
