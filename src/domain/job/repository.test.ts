import { describe, expect, test } from 'vitest';
import { assertSafeRepoUrl, repositorySlug, sameRepository } from './repository';

describe('assertSafeRepoUrl', () => {
  test('accepts an https github URL', () => {
    expect(assertSafeRepoUrl('https://github.com/r-hashi01/spindle.git')).toBe(
      'https://github.com/r-hashi01/spindle.git'
    );
  });

  test.each([
    ['a relative path', 'r-hashi01/spindle'],
    ['ssh', 'git@github.com:r-hashi01/spindle.git'],
    ['plain http', 'http://github.com/r-hashi01/spindle.git'],
    ['another host', 'https://gitlab.com/r-hashi01/spindle.git'],
    // A URL carrying a credential would put it in the clone command, the logs
    // and .git/config — the exact thing the outbound handler exists to avoid.
    ['an embedded credential', 'https://user:token@github.com/r-hashi01/spindle.git'],
  ])('rejects %s', (_label, url) => {
    expect(() => assertSafeRepoUrl(url)).toThrow();
  });
});

describe('sameRepository', () => {
  // A caller that sends the configured repository in a slightly different form
  // is asking for the default, not for a custom repository.
  test.each([
    ['https://github.com/o/r.git', 'https://github.com/o/r'],
    ['https://github.com/o/r/', 'https://github.com/o/r'],
    ['https://GitHub.com/O/R.git', 'https://github.com/o/r'],
  ])('treats %s and %s as the same repository', (a, b) => {
    expect(sameRepository(a, b)).toBe(true);
  });

  test('tells different repositories apart', () => {
    expect(sameRepository('https://github.com/o/r', 'https://github.com/o/other')).toBe(false);
  });
});

describe('repositorySlug', () => {
  test('reduces a clone URL to owner/name', () => {
    expect(repositorySlug('https://github.com/r-hashi01/spindle.git')).toBe('r-hashi01/spindle');
    expect(repositorySlug('https://github.com/r-hashi01/spindle/')).toBe('r-hashi01/spindle');
  });

  test('refuses anything that is not owner/name', () => {
    expect(() => repositorySlug('https://github.com/r-hashi01')).toThrow(/owner/);
    expect(() => repositorySlug('https://github.com/a/b/c')).toThrow(/owner/);
  });
});
