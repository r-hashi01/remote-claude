import type { ExecutorPolicy } from '../application/ports';
import { claudeCredential } from '../domain/agent/credential';
import {
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
} from '../domain/job/health';
import type { Env } from './env';

/**
 * The deployment's settings, read once per invocation.
 *
 * `Config` extends the application's `ExecutorPolicy`, so the use cases see
 * exactly the subset they declared they need and nothing about Cloudflare, while
 * the pieces only the infrastructure cares about (auth mode, allowed hosts, the
 * workspace cache) stay visible here.
 */
export interface Config extends ExecutorPolicy {
  claudeAuthMode: 'proxy' | 'direct';
  /**
   * Why no request to Anthropic will succeed, when that is the case.
   *
   * Carried rather than thrown: this is read in a Durable Object constructor,
   * and a deployment with no credential should still answer `GET /jobs` and say
   * what is wrong when asked — not fail to wake up.
   */
  claudeCredentialProblem?: string;
  allowedHosts: string[];
}

const DEFAULT_ALLOWED_HOSTS = [
  'github.com',
  'codeload.github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'api.anthropic.com',
  'registry.npmjs.org',
];

/** How long a job's record and logs are kept. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function num(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function loadConfig(env: Env): Config {
  const mode = (env.CLAUDE_AUTH_MODE ?? 'proxy').trim().toLowerCase();
  // Derived from which credential is configured, not from a flag — see
  // `domain/agent/credential.ts` for why there is no flag.
  const credential = claudeCredential({
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: env.ANTHROPIC_API_KEY,
  });

  return {
    repoUrl: env.REPO_URL,
    defaultBaseBranch: env.DEFAULT_BASE_BRANCH || 'main',
    claudeAuthMode: mode === 'direct' ? 'direct' : 'proxy',
    claudeAuthScheme: credential.scheme,
    claudeCredentialProblem: credential.problem,
    // Trimmed, and otherwise taken as written. Unlike a job's model this is not
    // validated for shape: it is the deployer's own string, it is shell-quoted
    // before it reaches `claude`, and a name that means nothing fails at the
    // agent step with Claude Code's own message — which names the model and the
    // alternatives, and is better than anything this file could say about it.
    model: env.CLAUDE_MODEL?.trim() || undefined,
    maxConcurrency: num(env.MAX_CONCURRENCY, 3),
    jobTimeoutMs: num(env.JOB_TIMEOUT_MS, 30 * 60 * 1000),
    claudeTimeoutMs: num(env.CLAUDE_TIMEOUT_MS, 25 * 60 * 1000),
    // Not configurable: these are properties of how the runner reports, not of
    // a deployment. See the reasoning in domain/job/health.ts.
    heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
    stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
    retentionMs: RETENTION_MS,
    // Above jobTimeoutMs on purpose: this is an inactivity timer over requests to
    // the container, and a job's work happens inside one. See the conventions
    // test that keeps the two in that order.
    sleepAfter: env.SANDBOX_SLEEP_AFTER || '35m',
    allowPush: bool(env.ALLOW_PUSH),
    allowCustomRepo: bool(env.ALLOW_CUSTOM_REPO),
    allowedHosts: parseAllowedHosts(env),
    commands: {
      install: (env.INSTALL_COMMAND ?? '').trim(),
      lint: (env.LINT_COMMAND ?? '').trim(),
      test: (env.TEST_COMMAND ?? '').trim(),
      build: (env.BUILD_COMMAND ?? '').trim(),
    },
  };
}

/** Used by the Sandbox subclass, which needs the list before full config load. */
export function parseAllowedHosts(env: Partial<Env>): string[] {
  const raw = (env.SANDBOX_ALLOWED_HOSTS ?? '').trim();
  // A copy either way: the rules below add to this list, and the default is
  // shared.
  const hosts = raw
    ? raw
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean)
    : [...DEFAULT_ALLOWED_HOSTS];
  // api.anthropic.com is required for Claude Code to function at all.
  if (!hosts.includes('api.anthropic.com')) hosts.push('api.anthropic.com');

  // Derived, not configured. A deployment that keeps workspaces uploads them
  // from inside the container to its own R2 endpoint, and the network is
  // deny-by-default — so enabling one feature would otherwise require
  // remembering to open a hole for it somewhere else entirely. It did: the first
  // upload that got as far as trying failed with a 520 from a host nobody had
  // allowed.
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (account) {
    const endpoint = `${account}.r2.cloudflarestorage.com`;
    // Both addressing styles, because the uploader picks one and the list is
    // matched by host. A small body goes to the path-style endpoint; a large one
    // becomes a multipart upload addressed to the bucket as a subdomain — and a
    // host that is not on this list is answered by the interception with its own
    // certificate, which arrives as "self signed certificate in certificate
    // chain" from inside the container. That is what it said, for the one upload
    // large enough to take the other path.
    const bucket = env.BACKUP_BUCKET_NAME?.trim();
    for (const host of [endpoint, ...(bucket ? [`${bucket}.${endpoint}`] : [])]) {
      if (!hosts.includes(host)) hosts.push(host);
    }
  }

  return hosts;
}
