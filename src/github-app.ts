import type { Env } from './types';

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
        'GITHUB_APP_INSTALLATION_ID (see README "GitHub App を用意する").'
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

  const data = (await response.json()) as { token: string; expires_at: string };
  const parsedExpiry = Date.parse(data.expires_at);
  cached = {
    token: data.token,
    expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 55 * 60 * 1000,
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
