import { repositorySlug } from './repository';

/**
 * Where npm keeps what it has already downloaded.
 *
 * Under the workspace, because that is the directory the snapshot mechanism
 * already reaches (ADR 0011) — and excluded from the workspace's own snapshot, so
 * a continuation restores the tree without carrying a second copy of the cache
 * inside it.
 */
export const PACKAGE_CACHE_DIR = '/workspace/.npm-cache';

/**
 * The cache a job may restore.
 *
 * Keyed by repository. npm's cache is content-addressed and additive, so a cache
 * from before a dependency bump still answers for everything that did not change,
 * which is nearly all of it. Keying by lockfile instead would mean reading the
 * lockfile out of the container before the runner starts, and starting from empty
 * every time any dependency moved — paying the full cost of the thing being avoided
 * for the sake of exactness nobody benefits from.
 */
export function cacheKeyFor(repoUrl: string): string {
  return `npm-${repositorySlug(repoUrl).replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
}

export interface CacheOutcome {
  /** Whether the install step ran at all. */
  installed: boolean;
  /** Whether it went to the network for anything. */
  fetched: boolean;
}

/**
 * Whether what the cache became is worth storing.
 *
 * Uploading costs time as well, so it is worth it exactly when the next job would
 * otherwise re-fetch. An install that was served entirely from the restored cache
 * has added nothing, and replacing the stored copy with an identical one spends a
 * transfer to arrive where it started.
 */
export function shouldKeepCache({ installed, fetched }: CacheOutcome): boolean {
  return installed && fetched;
}
