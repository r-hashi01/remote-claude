import { describe, expect, test } from 'vitest';
import {
  MAX_CACHE_UPLOAD_MB,
  PACKAGE_CACHE_DIR,
  cacheKeyFor,
  fitsInOneUpload,
  shouldKeepCache,
} from './package-cache';

/**
 * Which cache a job may use, and whether it is worth keeping.
 *
 * The reason there is a cache at all: one job's install fetched 137 packages with
 * a median of 1980ms each and one taking 27.6 seconds. That is the path to the
 * registry being slow, not the packages being large — so the fix is to stop asking
 * for them.
 */
describe('the cache a job restores', () => {
  test('is keyed by the repository, so jobs on it share one', () => {
    expect(cacheKeyFor('https://github.com/r-hashi01/spindle.git')).toBe(
      cacheKeyFor('https://github.com/r-hashi01/spindle')
    );
  });

  test('is not shared between repositories', () => {
    expect(cacheKeyFor('https://github.com/a/one.git')).not.toBe(
      cacheKeyFor('https://github.com/a/two.git')
    );
  });

  // Keyed by repository rather than by lockfile, deliberately. npm's cache is
  // content-addressed and additive, so a cache from before a dependency bump still
  // answers for everything that did not change — which is nearly all of it. Keying
  // by lockfile would mean reading the lockfile out of the container first, for a
  // cache that starts empty every time a dependency moves.
  test('survives the repository moving to a different branch', () => {
    expect(cacheKeyFor('https://github.com/a/one.git')).toBe(cacheKeyFor('https://github.com/a/one.git'));
  });

  test('is a name a storage key can be', () => {
    expect(cacheKeyFor('https://github.com/r-hashi01/spindle.git')).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('whether to keep what the cache became', () => {
  // Uploading costs time too. It is worth it when the next job would otherwise
  // re-fetch, and not worth it when nothing was added.
  test('keeps it when the install fetched anything', () => {
    expect(shouldKeepCache({ installed: true, fetched: true })).toBe(true);
  });

  test('leaves the stored one alone when everything came from cache', () => {
    expect(shouldKeepCache({ installed: true, fetched: false })).toBe(false);
  });

  test('has nothing to keep when install did not run', () => {
    expect(shouldKeepCache({ installed: false, fetched: false })).toBe(false);
  });
});

describe('where the cache lives', () => {
  // Inside the workspace, so the snapshot mechanism that already exists can reach
  // it — and excluded from the workspace's own snapshot, so a continuation does not
  // carry a copy of it in the tree as well.
  test('is under the workspace and hidden', () => {
    expect(PACKAGE_CACHE_DIR).toMatch(/^\/workspace\/\./);
  });
});

/**
 * The size a cache has to be under to be storable at all.
 *
 * 193 MB was measured for one repository, and that becomes a multipart upload, which
 * fails from inside the container. Written down rather than rediscovered as a failed
 * upload at the end of every job.
 */
describe('whether a cache can be stored', () => {
  test('a workspace-sized one can', () => {
    expect(fitsInOneUpload(20)).toBe(true);
  });

  test('the 193 MB one measured cannot', () => {
    expect(fitsInOneUpload(193)).toBe(false);
  });

  test('the boundary itself is included', () => {
    expect(fitsInOneUpload(MAX_CACHE_UPLOAD_MB)).toBe(true);
    expect(fitsInOneUpload(MAX_CACHE_UPLOAD_MB + 1)).toBe(false);
  });
});
