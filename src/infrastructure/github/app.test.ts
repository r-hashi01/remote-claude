import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  assertCanOpenPullRequests,
  assertRepositoryReachable,
  assertRepositoryWritable,
  installationPermissions,
  openPullRequest,
} from './app';
import { Refusal } from '../../domain/job/errors';
import type { Env } from '../env';

/**
 * The GitHub App adapter, against a GitHub that answers on demand.
 *
 * This file had no tests, and one of its rules had been wrong in production: the
 * write check read `permissions.push` from `GET /repos/{slug}`, a field an
 * installation token's response never carries, so every push was refused however
 * the App was configured. Nothing below this layer could have caught it — the
 * mistake was about which reply carries which fact, which is only visible when
 * something is answering.
 *
 * It runs in node rather than workerd because everything it needs is standard:
 * `fetch` to intercept, and WebCrypto to sign the App JWT with. The workerd suite
 * stays for properties that exist only there.
 */

const REPO = 'https://github.com/owner/name.git';
const INSTALLATION = '151907253';

let env: Env;

/** A key of the shape the App expects: PKCS#8, base64, PEM-wrapped. */
async function generatePrivateKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  // Cast because the runtime types allow a JWK here; 'pkcs8' always yields bytes.
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const base64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  return `-----BEGIN PRIVATE KEY-----\n${(base64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----`;
}

beforeAll(async () => {
  env = {
    GITHUB_APP_ID: '1234',
    GITHUB_APP_INSTALLATION_ID: INSTALLATION,
    GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
  } as unknown as Env;
});

afterEach(() => vi.unstubAllGlobals());

interface Answer {
  status?: number;
  body?: unknown;
}

/**
 * Stand in for GitHub, and record what was asked.
 *
 * `expires_at` on the minted token is deliberately immediate: the token is cached
 * in module state under no key, so a case that let it live would decide what every
 * later case sees. Expiring it also exercises the refresh that cache exists for.
 */
function githubAnswers(answers: {
  mint?: Answer & { permissions?: Record<string, string> };
  repo?: Answer;
  pulls?: Answer;
}): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const target = String(url);
    calls.push(`${init?.method ?? 'GET'} ${new URL(target).pathname}`);

    if (target.includes('/access_tokens')) {
      const mint = answers.mint ?? {};
      return Response.json(
        mint.body ?? {
          token: 'ghs_installationtoken',
          expires_at: new Date(Date.now() + 1_000).toISOString(),
          permissions: mint.permissions ?? { contents: 'write', pull_requests: 'write' },
        },
        { status: mint.status ?? 201 }
      );
    }
    if (target.endsWith('/pulls')) {
      const pulls = answers.pulls ?? {};
      return Response.json(pulls.body ?? { html_url: 'https://github.com/owner/name/pull/7' }, {
        status: pulls.status ?? 201,
      });
    }
    const repo = answers.repo ?? {};
    return Response.json(repo.body ?? { full_name: 'owner/name' }, { status: repo.status ?? 200 });
  });
  return { calls };
}

describe('what the installation may do', () => {
  // The defect this file exists for. `contents: write` arrives with the token; it
  // is not a property of the repository, and asking the repository for it read a
  // field that is never there.
  test('is read off the token it minted, not off the repository', async () => {
    const github = githubAnswers({ mint: { permissions: { contents: 'write' } } });

    await assertRepositoryWritable(env, REPO);

    expect(await installationPermissions(env)).toMatchObject({ contents: 'write' });
    expect(github.calls).toContain(`POST /app/installations/${INSTALLATION}/access_tokens`);
  });

  test('refuses a push it cannot deliver, and says where to change it', async () => {
    githubAnswers({ mint: { permissions: { contents: 'read' } } });

    const failure = await assertRepositoryWritable(env, REPO).catch((error) => error);
    expect(failure).toBeInstanceOf(Refusal);
    expect(failure.message).toMatch(/Contents permission must be Read and write/);
  });

  test('refuses a pull request it has no permission to open', async () => {
    githubAnswers({ mint: { permissions: { contents: 'write' } } });

    await expect(assertCanOpenPullRequests(env, REPO)).rejects.toThrow(/Pull requests/);
  });
});

describe('whether a repository is reachable at all', () => {
  test('accepts one the installation can see', async () => {
    githubAnswers({});
    await expect(assertRepositoryReachable(env, REPO)).resolves.toBeUndefined();
  });

  // 404 is GitHub's answer for a repository the installation was never given,
  // whether or not it exists — so the message names the installation to add it to
  // rather than guessing which of the two it is.
  test('refuses one it cannot, naming the installation', async () => {
    githubAnswers({ repo: { status: 404, body: { message: 'Not Found' } } });

    await expect(assertRepositoryReachable(env, REPO)).rejects.toThrow(
      new RegExp(`cannot reach owner/name.*${INSTALLATION}`, 's')
    );
  });

  // Anything other than present or absent is this executor's problem to report,
  // not a repository the caller should be told to go and add.
  test('does not turn a broken GitHub into a refusal', async () => {
    githubAnswers({ repo: { status: 500, body: { message: 'upstream is unwell' } } });

    const failure = await assertRepositoryReachable(env, REPO).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(Refusal);
    expect(failure.message).toMatch(/could not read owner\/name from GitHub: 500/);
  });

  test('says so when the App is not configured at all', async () => {
    githubAnswers({});
    const unconfigured = {} as Env;

    await expect(assertRepositoryReachable(unconfigured, REPO)).rejects.toThrow(/GitHub App/);
  });
});

describe('opening a pull request', () => {
  const request = {
    repo: REPO,
    head: 'claude/job-1',
    base: 'main',
    title: 'a title',
    body: 'a body',
    draft: false,
  };

  test('returns the URL GitHub gave it', async () => {
    githubAnswers({});
    expect(await openPullRequest(env, request)).toBe('https://github.com/owner/name/pull/7');
  });

  // The message a person needs is GitHub's own — "no commits between" means the
  // branch is empty, which is a different problem from a permission.
  test('reports what GitHub said when it will not', async () => {
    githubAnswers({
      pulls: { status: 422, body: { message: 'No commits between main and claude/job-1' } },
    });

    await expect(openPullRequest(env, request)).rejects.toThrow(
      /No commits between main and claude\/job-1/
    );
  });
});
