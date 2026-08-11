import { Refusal } from './errors';
/**
 * Which repository a job runs against.
 *
 * The rules here are about shape only — https, github.com, no embedded
 * credential, and whether this deployment accepts a repository other than its
 * configured one. Whether a *particular* repository may be worked on is not
 * decided here and not decided from a list: it is whatever the deployment's
 * GitHub App installation can reach, which only GitHub can answer. See the
 * `GitHubAccess` port.
 */

/** Only https github.com URLs, and never one carrying inline credentials. */
export function assertSafeRepoUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refusal('repo must be an absolute https URL');
  }
  if (url.protocol !== 'https:') throw new Refusal('repo must use https');
  if (url.username || url.password) throw new Refusal('repo URL must not embed credentials');
  if (url.hostname !== 'github.com') throw new Refusal('repo must be hosted on github.com');
  return url.toString();
}

/**
 * Whether two URLs name the same repository.
 *
 * A caller that sends the configured repository with a `.git` suffix, a
 * trailing slash or different capitalisation is asking for the default, not for
 * a custom repository, and a deployment with custom repositories switched off
 * should not refuse it.
 */
export function sameRepository(a: string, b: string): boolean {
  return repositoryKey(a) === repositoryKey(b);
}

/** `https://github.com/owner/name.git` → `owner/name`. */
export function repositorySlug(repoUrl: string): string {
  const path = new URL(repoUrl).pathname
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const segments = path.split('/');
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Refusal(`repo must be a github.com/<owner>/<name> URL, got ${repoUrl}`);
  }
  return `${segments[0]}/${segments[1]}`;
}

export interface RepositoryChoice {
  repo: string;
  /**
   * True when the caller asked for something other than the configured
   * repository, and the credential's reach therefore has to be confirmed
   * before the job starts.
   */
  isCustom: boolean;
}

/**
 * Resolve the repository a job will use, given what this deployment allows.
 *
 * The refusal names both repositories and says whose configuration it is. A
 * bare "custom repositories are disabled" arriving inside another product reads
 * like that product's bug, and the caller has done nothing wrong.
 */
export function resolveRepository(
  requested: string | undefined,
  configured: string,
  allowCustom: boolean
): RepositoryChoice {
  if (!requested || sameRepository(requested, configured)) {
    return { repo: configured, isCustom: false };
  }
  if (!allowCustom) {
    throw new Refusal(
      `this executor is pinned to ${configured} and will not run against ${requested}: ` +
        'custom repositories are disabled on the executor. Set ALLOW_CUSTOM_REPO=true in its ' +
        'wrangler.jsonc vars and redeploy, or point it at that repository.'
    );
  }
  return { repo: assertSafeRepoUrl(requested), isCustom: true };
}

function repositoryKey(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
    return `${url.hostname}${path}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}
