import type { GitHubAccess, OpenPullRequest } from '../../application/ports';
import {
  canOpenPullRequests,
  canPush,
  type InstallationPermissions,
} from '../../domain/job/permissions';
import { repositorySlug } from '../../domain/job/repository';
import type { Env } from '../env';

/**
 * GitHub App authentication.
 *
 * Replaces a long-lived personal access token with short-lived (~1h)
 * installation access tokens, minted on demand from a JWT signed with the
 * App's private key. The private key and the minted tokens never leave the
 * Workers runtime — see the credential posture note in sandbox.ts.
 */

const JWT_TTL_SECONDS = 540; // GitHub caps App JWTs at 10 minutes; stay under it.
const CLOCK_SKEW_SECONDS = 60; // Back-date `iat` in case clocks disagree slightly.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

export function loadGitHubAppConfig(env: Env): GitHubAppConfig | null {
  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID } = env;
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY || !GITHUB_APP_INSTALLATION_ID) return null;
  return {
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_APP_PRIVATE_KEY,
    installationId: GITHUB_APP_INSTALLATION_ID,
  };
}

interface CachedToken {
  token: string;
  expiresAt: number;
  /**
   * What this token is allowed to do, as GitHub reported when minting it.
   *
   * Kept with the token because it describes that token. Asking a repository
   * endpoint instead reads a field installation tokens do not carry — which is
   * how the first write check came to refuse everything.
   */
  permissions: InstallationPermissions;
}

/**
 * Cached across requests within one isolate, keyed by nothing request- or
 * user-specific: it represents the App installation's own credential, so
 * reusing it for any caller is correct, and the expiry check below makes
 * staleness self-correcting rather than something that can leak or drift.
 */
let cached: CachedToken | null = null;
let inflight: Promise<string> | null = null;

/** Installation access token for git-over-HTTPS and REST calls to GitHub. */
export async function getInstallationToken(env: Env): Promise<string> {
  const config = loadGitHubAppConfig(env);
  if (!config) {
    throw new Error(
      'GitHub App is not configured: set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and ' +
        'GITHUB_APP_INSTALLATION_ID (see docs/operating.md, "A GitHub App").'
    );
  }

  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  if (inflight) return inflight;

  inflight = mintInstallationToken(config).finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Refuse a repository the GitHub App installation cannot actually reach.
 *
 * The authorization boundary for "which repositories may this executor work
 * on" is the App installation itself, not a list kept here — a second list
 * would be a second thing to get wrong, and it could only ever be a subset of
 * what the credential already permits. So this asks GitHub rather than
 * deciding: what the token can see is the answer.
 *
 * Called before a job starts, because the alternative is discovering it during
 * `git clone` minutes later, as an authentication failure that reads like a
 * broken deployment rather than a repository nobody granted access to.
 *
 * Deliberately not cached. The result is a permission, and a permission that
 * was revoked five minutes ago is not one.
 */
export async function assertRepositoryReachable(env: Env, repoUrl: string): Promise<void> {
  const slug = repositorySlug(repoUrl);
  const installationId = env.GITHUB_APP_INSTALLATION_ID ?? 'the configured installation';

  if ((await fetchRepository(env, slug)) !== null) return;

  throw new Error(
    `this executor's GitHub App installation cannot reach ${slug}. The repository must be ` +
      `added to installation ${installationId} (GitHub → Settings → Applications → the App → ` +
      `Configure → Repository access) before a job can run against it.`
  );
}

/**
 * Refuse a push the installation cannot deliver.
 *
 * Same shape as the reachability check and for the same reason: a job that will
 * fail at `git push` after twenty minutes of work should be refused when it is
 * submitted. GitHub reports what the installation may do on a repository, so ask
 * it rather than inferring it from the App's configuration.
 */
export async function assertRepositoryWritable(env: Env, repoUrl: string): Promise<void> {
  const slug = repositorySlug(repoUrl);

  // Reachable first: an installation with contents:write still cannot push to a
  // repository it was never given.
  await assertRepositoryReachable(env, repoUrl);

  if (!canPush(await installationPermissions(env))) {
    throw new Error(
      `this executor's GitHub App installation cannot write to ${slug}. Its Contents permission ` +
        'must be Read and write for a job to push (GitHub → Settings → Developer settings → ' +
        'GitHub Apps → the App → Permissions), and permission changes have to be accepted on the ' +
        'installation before they take effect.'
    );
  }
}

/**
 * Refuse a pull request the credential could not open.
 *
 * A separate permission from writing contents: an App can be allowed to push a
 * branch and not to open a pull request for it.
 */
export async function assertCanOpenPullRequests(env: Env, repoUrl: string): Promise<void> {
  const slug = repositorySlug(repoUrl);
  if (canOpenPullRequests(await installationPermissions(env))) return;

  throw new Error(
    `this executor's GitHub App installation cannot open pull requests on ${slug}. Its Pull ` +
      'requests permission must be Read and write, and the change has to be accepted on the ' +
      'installation before it takes effect.'
  );
}

/**
 * Open the pull request, and return its URL.
 *
 * Runs on this side rather than in the container: it is a control-plane action,
 * and the credential for it lives here (ADR 0002).
 */
export async function openPullRequest(env: Env, input: OpenPullRequest): Promise<string> {
  const slug = repositorySlug(input.repo);
  const token = await getInstallationToken(env);

  const response = await fetch(`https://api.github.com/repos/${slug}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'remote-claude',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: input.draft,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // 422 is the common one and is usually informative: no commits between the
    // branches, or a pull request already open for them.
    throw new Error(`GitHub refused the pull request (${response.status}): ${body.slice(0, 300)}`);
  }

  const created = (await response.json()) as { html_url?: string };
  if (!created.html_url) throw new Error('GitHub accepted the pull request but returned no URL');
  return created.html_url;
}

/** What the current installation token is allowed to do. */
export async function installationPermissions(env: Env): Promise<InstallationPermissions> {
  // Minting populates the cache; the permissions come back with the token.
  await getInstallationToken(env);
  return cached?.permissions ?? {};
}

/** The `GitHubAccess` port, bound to this deployment's App installation. */
export class GitHubAppAccess implements GitHubAccess {
  constructor(private readonly env: Env) {}

  assertRepositoryReachable(repoUrl: string): Promise<void> {
    return assertRepositoryReachable(this.env, repoUrl);
  }

  assertRepositoryWritable(repoUrl: string): Promise<void> {
    return assertRepositoryWritable(this.env, repoUrl);
  }

  assertCanOpenPullRequests(repoUrl: string): Promise<void> {
    return assertCanOpenPullRequests(this.env, repoUrl);
  }

  openPullRequest(input: OpenPullRequest): Promise<string> {
    return openPullRequest(this.env, input);
  }
}

/** Whether this installation can see the repository at all. */
async function fetchRepository(env: Env, slug: string): Promise<object | null> {
  const token = await getInstallationToken(env);
  const response = await fetch(`https://api.github.com/repos/${slug}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'remote-claude',
    },
  });

  // 404 rather than 403 is the usual answer for a repository outside the
  // installation: GitHub does not confirm that private repositories exist to
  // credentials that cannot see them.
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `could not read ${slug} from GitHub: ${response.status} ${body.slice(0, 200)}`
    );
  }
  return (await response.json()) as object;
}

async function mintInstallationToken(config: GitHubAppConfig): Promise<string> {
  const jwt = await signAppJwt(config.appId, config.privateKey);

  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'remote-claude',
      },
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`failed to mint GitHub App installation token (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    token: string;
    expires_at: string;
    permissions?: InstallationPermissions;
  };
  const parsedExpiry = Date.parse(data.expires_at);
  cached = {
    token: data.token,
    expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 55 * 60 * 1000,
    permissions: data.permissions ?? {},
  };
  return cached.token;
}

async function signAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const encodedPayload = base64url(
    JSON.stringify({ iat: now - CLOCK_SKEW_SECONDS, exp: now + JWT_TTL_SECONDS, iss: appId })
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64url(signature)}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // `.dev.vars` / `wrangler secret put` both accept real newlines, but some
  // secret stores round-trip PEMs as a single line with literal "\n".
  const normalized = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  const body = normalized
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');

  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY is not valid base64 PEM content');
  }

  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch {
    throw new Error(
      'failed to import GITHUB_APP_PRIVATE_KEY. GitHub issues App keys as PKCS#1 ' +
        '("-----BEGIN RSA PRIVATE KEY-----"), but this runtime requires PKCS#8. Convert it once with: ' +
        'openssl pkcs8 -topk8 -nocrypt -in original-key.pem -out pkcs8-key.pem, then store the ' +
        'pkcs8-key.pem contents instead.'
    );
  }
}

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
