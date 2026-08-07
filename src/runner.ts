import { getSandbox } from '@cloudflare/sandbox';
import type { Config } from './config';
import type { Redactor } from './redact';
import type { Env, StepResult, TaskRecord, TaskResult, TaskStatus } from './types';

const REPO_DIR = '/workspace/repo';
const GIT_USER_NAME = 'remote-claude';
const GIT_USER_EMAIL = 'remote-claude@users.noreply.github.com';

/** Tail of a step's output kept in the task result (full text stays in logs). */
const MAX_STEP_OUTPUT = 20_000;
/** Hard cap on the stored patch. */
const MAX_PATCH_BYTES = 1_000_000;
/** Hard cap on an accepted prompt. */
export const MAX_PROMPT_LENGTH = 20_000;

const EXTRA_SYSTEM_PROMPT = [
  'You are running non-interactively inside an isolated Cloudflare Sandbox,',
  'on a dedicated branch of a checked-out git repository.',
  'Apply every change needed to satisfy the request directly to the files.',
  'Do NOT run `git commit`, `git push`, or any command that rewrites history —',
  'the surrounding pipeline commits your work and captures the diff.',
  'Do not attempt to read or print environment variables containing credentials.',
].join(' ');

export class TaskCancelledError extends Error {
  constructor() {
    super('task cancelled');
    this.name = 'TaskCancelledError';
  }
}

/** Wrap a value as a single-quoted POSIX shell argument. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated, ${text.length - limit} more characters]`;
}

type Sandbox = ReturnType<typeof getSandbox>;

export interface TaskRunOutcome {
  result: TaskResult;
  /** Full unified diff of baseBranch..HEAD, redacted and size-capped. */
  patch: string;
}

export interface RunnerDeps {
  env: Env;
  config: Config;
  redact: Redactor;
  signal: AbortSignal;
  log: (stream: 'system' | 'stdout' | 'stderr', line: string) => void;
  setStatus: (status: TaskStatus) => void;
}

export async function runTask(task: TaskRecord, deps: RunnerDeps): Promise<TaskRunOutcome> {
  const { env, config, redact, signal, log, setStatus } = deps;

  const throwIfCancelled = () => {
    if (signal.aborted) throw new TaskCancelledError();
  };

  setStatus('starting');
  log('system', `task ${task.id}`);
  log('system', `repo ${task.repo}`);
  log('system', `base branch ${task.baseBranch} → work branch ${task.branch}`);
  log('system', `claude auth mode: ${config.claudeAuthMode}`);

  const sandbox = getSandbox(env.Sandbox, `rc-${task.id}`, {
    sleepAfter: config.sleepAfter,
    enableDefaultSession: false,
  });

  // Killing in-flight processes is how cancellation reaches into the container:
  // the pending exec() then returns with a non-zero exit code.
  const onAbort = () => {
    log('system', 'cancellation requested — killing sandbox processes');
    void sandbox.killAllProcesses().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const steps: StepResult[] = [];

  /** Run a command in the sandbox, streaming its output into the task log. */
  const run = async (
    name: string,
    command: string,
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeout?: number;
      allowFailure?: boolean;
      /** Override the per-step output cap (the patch and Claude's reply need more). */
      maxOutput?: number;
    } = {}
  ): Promise<StepResult> => {
    throwIfCancelled();
    const startedAt = Date.now();
    log('system', `▶ ${name}`);

    const chunks: string[] = [];
    const exec = sandbox.exec(command, {
      cwd: options.cwd ?? REPO_DIR,
      env: options.env,
      timeout: options.timeout,
      stream: true,
      onOutput: (stream, data) => {
        const clean = redact(data);
        chunks.push(clean);
        for (const line of clean.split('\n')) {
          if (line.trim()) log(stream, line);
        }
      },
    });

    // Race the command against cancellation so a killed process cannot hang us.
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) return reject(new TaskCancelledError());
      signal.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true });
    });

    const result = await Promise.race([exec, aborted]);
    const combined = redact(`${result.stdout ?? ''}${result.stderr ?? ''}` || chunks.join(''));

    const step: StepResult = {
      name,
      command: redact(command),
      exitCode: result.exitCode ?? (result.success ? 0 : 1),
      success: result.success,
      durationMs: Date.now() - startedAt,
      output: truncate(combined, options.maxOutput ?? MAX_STEP_OUTPUT),
    };
    steps.push(step);
    log('system', `${step.success ? '✔' : '✖'} ${name} (exit ${step.exitCode}, ${step.durationMs}ms)`);

    if (!step.success && !options.allowFailure) {
      throw new Error(`step "${name}" failed with exit code ${step.exitCode}`);
    }
    return step;
  };

  /** Record a configured-but-empty command as an explicit skip. */
  const skip = (name: string, reason: string) => {
    steps.push({
      name,
      command: '',
      exitCode: 0,
      success: true,
      durationMs: 0,
      output: reason,
      skipped: true,
    });
    log('system', `⏭ ${name} — ${reason}`);
  };

  try {
    setStatus('running');

    // ---- 1. Prepare the workspace ------------------------------------
    await prepareRepo(sandbox, task, deps, run);
    throwIfCancelled();

    // ---- 2. Prove no API-key credential leaked into the container -----
    // `printenv` prints nothing and exits non-zero when the vars are unset.
    const leakProbe = await run('verify-no-api-key', 'printenv ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN', {
      env: claudeEnvironment(env, config),
      allowFailure: true,
    });
    if (leakProbe.output.trim().length > 0) {
      throw new Error(
        'ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set inside the container. ' +
          'Refusing to run: this environment must use subscription OAuth only.'
      );
    }
    log('system', 'verified: no API-key credential present in the container');

    // ---- 3. Branch off the base --------------------------------------
    await run('git-config', `git -C ${REPO_DIR} config user.name ${shellQuote(GIT_USER_NAME)}`);
    await run('git-config-email', `git -C ${REPO_DIR} config user.email ${shellQuote(GIT_USER_EMAIL)}`);
    await run('git-branch', `git -C ${REPO_DIR} checkout -b ${shellQuote(task.branch)}`);

    // ---- 4. Install dependencies -------------------------------------
    if (config.commands.install) {
      await run('install', config.commands.install, { timeout: config.taskTimeoutMs });
    } else {
      skip('install', 'INSTALL_COMMAND is not configured');
    }

    // ---- 5. Snapshot the prepared workspace (optional cache) ----------
    if (config.workspaceCache) {
      await createWorkspaceSnapshot(sandbox, deps);
    }

    // ---- 6. Claude Code ----------------------------------------------
    const claudeStep = await runClaude(task, deps, run);

    // ---- 7. Project checks -------------------------------------------
    if (task.options.skipChecks) {
      skip('checks', 'skipChecks was requested for this task');
    } else {
      for (const [name, command] of [
        ['lint', config.commands.lint],
        ['test', config.commands.test],
        ['build', config.commands.build],
      ] as const) {
        if (command) {
          // Check failures are reported, not fatal: the diff is still useful.
          await run(name, command, { timeout: config.taskTimeoutMs, allowFailure: true });
        } else {
          skip(name, `${name.toUpperCase()}_COMMAND is not configured`);
        }
      }
    }

    // ---- 8. Commit and capture artifacts -----------------------------
    return await collectResult(task, deps, run, steps, claudeStep.output);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (task.options.keepSandbox) {
      log('system', `sandbox kept alive (idles out after ${config.sleepAfter})`);
    } else {
      try {
        await sandbox.destroy();
        log('system', 'sandbox destroyed');
      } catch (error) {
        log('system', `sandbox destroy failed: ${redact(String(error))}`);
      }
    }
  }
}

/**
 * Environment handed to commands in the container.
 *
 * `undefined` unsets a variable. In `proxy` mode the OAuth value is a sentinel
 * and the real token is swapped in by the Worker's outbound handler.
 */
function claudeEnvironment(env: Env, config: Config): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN:
      config.claudeAuthMode === 'proxy' ? 'proxy-injected' : env.CLAUDE_CODE_OAUTH_TOKEN,
    IS_SANDBOX: '1',
    CI: '1',
  };
}

type RunFn = (
  name: string,
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
    allowFailure?: boolean;
    maxOutput?: number;
  }
) => Promise<StepResult>;

/** Fresh clone, or restore-then-refresh when the workspace cache is on. */
async function prepareRepo(sandbox: Sandbox, task: TaskRecord, deps: RunnerDeps, run: RunFn): Promise<void> {
  const { config, log, redact } = deps;
  const base = task.baseBranch;

  if (config.workspaceCache) {
    const restored = await restoreWorkspaceSnapshot(sandbox, deps);
    if (restored) {
      log('system', 'restored cached workspace — refreshing against origin');
      await run('git-fetch', `git -C ${REPO_DIR} fetch --prune origin ${shellQuote(base)}`, { timeout: 300_000 });
      await run('git-checkout-base', `git -C ${REPO_DIR} checkout ${shellQuote(base)}`);
      await run('git-reset', `git -C ${REPO_DIR} reset --hard ${shellQuote(`origin/${base}`)}`);
      await run('git-clean', `git -C ${REPO_DIR} clean -fd`, { allowFailure: true });
      return;
    }
    log('system', 'no usable workspace cache — falling back to a fresh clone');
  }

  log('system', `cloning ${redact(task.repo)} (${base})`);
  await sandbox.gitCheckout(task.repo, { branch: base, targetDir: REPO_DIR });
  log('system', 'clone complete');
}

async function createWorkspaceSnapshot(sandbox: Sandbox, deps: RunnerDeps): Promise<void> {
  const { env, config, log, redact } = deps;
  if (!env.BACKUP_BUCKET) {
    log('system', 'workspace cache is on but no BACKUP_BUCKET binding — skipping snapshot');
    return;
  }
  try {
    const backup = await sandbox.createBackup({
      dir: '/workspace',
      name: 'remote-claude-workspace',
      ttl: config.workspaceCacheTtl,
      gitignore: true,
    });
    await env.BACKUP_BUCKET.put('cache/workspace.json', JSON.stringify(backup));
    log('system', `workspace snapshot stored (ttl ${config.workspaceCacheTtl}s)`);
  } catch (error) {
    // A cache miss must never fail the task.
    log('system', `workspace snapshot failed (non-fatal): ${redact(String(error))}`);
  }
}

async function restoreWorkspaceSnapshot(sandbox: Sandbox, deps: RunnerDeps): Promise<boolean> {
  const { env, log, redact } = deps;
  if (!env.BACKUP_BUCKET) return false;
  try {
    const object = await env.BACKUP_BUCKET.get('cache/workspace.json');
    if (!object) return false;
    const handle = JSON.parse(await object.text()) as { id: string; dir: string };
    const result = await sandbox.restoreBackup(handle);
    return result.success;
  } catch (error) {
    log('system', `workspace restore failed (non-fatal): ${redact(String(error))}`);
    return false;
  }
}

async function runClaude(task: TaskRecord, deps: RunnerDeps, run: RunFn): Promise<StepResult> {
  const { env, config } = deps;

  // `unset` is belt-and-braces on top of passing the vars as undefined: it
  // guarantees no API-key fallback even if the image ever gains a default.
  const command = [
    'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;',
    'claude -p',
    shellQuote(task.prompt),
    '--permission-mode bypassPermissions',
    '--append-system-prompt',
    shellQuote(EXTRA_SYSTEM_PROMPT),
  ].join(' ');

  return run('claude-code', command, {
    env: claudeEnvironment(env, config),
    timeout: config.claudeTimeoutMs,
    allowFailure: false,
  });
}

async function collectResult(
  task: TaskRecord,
  deps: RunnerDeps,
  run: RunFn,
  steps: StepResult[],
  claudeOutput: string
): Promise<TaskRunOutcome> {
  const { config, redact, log } = deps;

  const porcelain = await run('git-status-porcelain', `git -C ${REPO_DIR} status --porcelain`, {
    allowFailure: true,
  });
  const changed = porcelain.output.trim().length > 0;

  let commitSha: string | undefined;
  if (changed) {
    await run('git-add', `git -C ${REPO_DIR} add -A`);
    const message = `${task.prompt.split('\n')[0].slice(0, 68)}\n\nremote-claude task ${task.id}`;
    await run('git-commit', `git -C ${REPO_DIR} commit -m ${shellQuote(message)}`);
    const sha = await run('git-rev-parse', `git -C ${REPO_DIR} rev-parse HEAD`, { allowFailure: true });
    commitSha = sha.output.trim() || undefined;
  } else {
    log('system', 'Claude Code produced no file changes');
  }

  const range = `${shellQuote(task.baseBranch)}..HEAD`;
  const status = await run('git-status', `git -C ${REPO_DIR} status --short --branch`, { allowFailure: true });
  const diffStat = await run('git-diff-stat', `git -C ${REPO_DIR} diff --stat ${range}`, { allowFailure: true });
  // The patch is the actual deliverable, so it gets the full budget rather
  // than the per-step output cap.
  const patch = await run('git-diff', `git -C ${REPO_DIR} diff ${range}`, {
    allowFailure: true,
    maxOutput: MAX_PATCH_BYTES,
  });

  // ---- optional push ------------------------------------------------
  let pushed = false;
  if (task.options.push && changed) {
    if (!config.allowPush) {
      log('system', 'push requested but ALLOW_PUSH is false on the Worker — skipping');
    } else {
      const push = await run(
        'git-push',
        `git -C ${REPO_DIR} push --set-upstream origin ${shellQuote(task.branch)}`,
        { allowFailure: true }
      );
      pushed = push.success;
    }
  }

  const patch_ = truncate(redact(patch.output), MAX_PATCH_BYTES);
  // The patch is persisted as its own artifact; keep it out of the task record
  // so a large diff cannot bloat (or overflow) the stored row.
  patch.output = '(retrieve with GET /tasks/:id/diff)';

  return {
    result: {
      claudeOutput,
      changed,
      commitSha,
      branch: task.branch,
      pushed,
      gitStatus: status.output.trim(),
      diffStat: diffStat.output.trim(),
      diffBytes: patch_.length,
      steps,
    },
    patch: patch_,
  };
}
