import type { Env } from './types';

export interface Config {
  repoUrl: string;
  defaultBaseBranch: string;
  claudeAuthMode: 'proxy' | 'direct';
  maxConcurrency: number;
  taskTimeoutMs: number;
  claudeTimeoutMs: number;
  sleepAfter: string;
  allowPush: boolean;
  allowCustomRepo: boolean;
  workspaceCache: boolean;
  workspaceCacheTtl: number;
  allowedHosts: string[];
  commands: {
    install: string;
    lint: string;
    test: string;
    build: string;
  };
}

const DEFAULT_ALLOWED_HOSTS = [
  'github.com',
  'codeload.github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'api.anthropic.com',
  'registry.npmjs.org',
];

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

  return {
    repoUrl: env.REPO_URL,
    defaultBaseBranch: env.DEFAULT_BASE_BRANCH || 'main',
    claudeAuthMode: mode === 'direct' ? 'direct' : 'proxy',
    maxConcurrency: num(env.MAX_CONCURRENCY, 3),
    taskTimeoutMs: num(env.TASK_TIMEOUT_MS, 30 * 60 * 1000),
    claudeTimeoutMs: num(env.CLAUDE_TIMEOUT_MS, 25 * 60 * 1000),
    sleepAfter: env.SANDBOX_SLEEP_AFTER || '5m',
    allowPush: bool(env.ALLOW_PUSH),
    allowCustomRepo: bool(env.ALLOW_CUSTOM_REPO),
    workspaceCache: (env.WORKSPACE_CACHE ?? 'off').trim().toLowerCase() === 'on',
    workspaceCacheTtl: num(env.WORKSPACE_CACHE_TTL, 7 * 24 * 60 * 60),
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
  if (!raw) return DEFAULT_ALLOWED_HOSTS;
  const hosts = raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  // api.anthropic.com is required for Claude Code to function at all.
  if (!hosts.includes('api.anthropic.com')) hosts.push('api.anthropic.com');
  return hosts;
}
