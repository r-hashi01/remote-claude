import { describe, expect, test } from 'vitest';
import { canOpenPullRequests, canPush } from './permissions';

describe('canPush', () => {
  test('write means write', () => {
    expect(canPush({ contents: 'write' })).toBe(true);
  });

  // The posture a fresh GitHub App is set up with, and the one the README tells
  // you to start from.
  test('read-only cannot push', () => {
    expect(canPush({ contents: 'read' })).toBe(false);
  });

  // The first version of this check read a field that installation tokens never
  // carry, so it was permanently in this branch — refusing jobs the credential
  // could have delivered.
  test('an absent permission is not a permission', () => {
    expect(canPush({})).toBe(false);
    expect(canPush(undefined)).toBe(false);
  });

  test('nothing else counts as write', () => {
    expect(canPush({ contents: 'admin' })).toBe(false);
    expect(canPush({ contents: '' })).toBe(false);
  });
});

describe('canOpenPullRequests', () => {
  test('is a separate permission from writing contents', () => {
    expect(canOpenPullRequests({ contents: 'write' })).toBe(false);
    expect(canOpenPullRequests({ contents: 'write', pull_requests: 'write' })).toBe(true);
  });
});
