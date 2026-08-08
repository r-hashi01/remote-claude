#!/usr/bin/env node
/**
 * In-container job runner.
 *
 * Why this exists: the pipeline used to run step-by-step from the Durable
 * Object, awaiting each `sandbox.exec` round trip. That capped a job at roughly
 * 51 seconds — a Durable Object gets 30 seconds of CPU between incoming
 * requests and is liable to be evicted past that, and `waitUntil` is not
 * documented to extend its lifetime. Jobs longer than that died with the run
 * still marked running.
 *
 * So the pipeline moved here. The container is built for long work; the Durable
 * Object now only starts this process and polls the files it writes.
 *
 * Redaction note: this process deliberately does NOT know any secret values.
 * In the default auth mode no real credential ever enters the container — the
 * Worker swaps a placeholder on the way out. So redaction here is pattern-based
 * only, and the Worker applies value-based redaction again when it reads these
 * files. Two independent layers, and nothing sensitive had to be handed over to
 * get them.
 *
 * Contract with the Worker — everything under $STATE_DIR:
 *   job.json      input, written by the Worker before this starts
 *   log.ndjson    append-only; one JSON object per line
 *   status.json   current phase; rewritten as it changes
 *   result.json   written once, on completion
 *   patch.diff    written once, on completion
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const STATE_DIR = process.argv[2] ?? '/workspace/.remote-claude';
const REPO_DIR = process.env.REPO_DIR ?? '/workspace/repo';

const GIT_USER_NAME = 'remote-claude';
const GIT_USER_EMAIL = 'remote-claude@users.noreply.github.com';
const MAX_STEP_OUTPUT = 20_000;
const MAX_PATCH_BYTES = 1_000_000;

const EXTRA_SYSTEM_PROMPT = [
  'You are running non-interactively inside an isolated cloud sandbox,',
  'on a dedicated branch of a checked-out git repository.',
  'Apply every change needed to satisfy the request directly to the files.',
  'Do NOT run `git commit`, `git push`, or any command that rewrites history —',
  'the surrounding pipeline commits your work and captures the diff.',
  'Do not attempt to read or print environment variables containing credentials.',
].join(' ');

// --------------------------------------------------------------- redaction

const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_\-]{16,}/g, '[redacted:anthropic-key]'],
  [/sk-ant-oat[A-Za-z0-9_\-]{16,}/g, '[redacted:anthropic-oauth]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted:github-token]'],
  [/github_pat_[A-Za-z0-9_]{40,}/g, '[redacted:github-pat]'],
  [/(?<=[Aa]uthorization:\s*[Bb]earer\s+)[\w\-.~+/=]{12,}/g, '[redacted]'],
  [/(?<=[Aa]uthorization:\s*[Bb]asic\s+)[\w\-.~+/=]{12,}/g, '[redacted]'],
  [/(?<=:\/\/)[^/\s:@]+:[^/\s@]+(?=@)/g, '[redacted]'],
];

function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// ------------------------------------------------------------- state files

function write(name, data) {
  const path = `${STATE_DIR}/${name}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
}

let logSeq = 0;
function log(stream, line) {
  const clean = redact(line);
  if (!clean.trim()) return;
  logSeq += 1;
  appendFileSync(
    `${STATE_DIR}/log.ndjson`,
    JSON.stringify({ seq: logSeq, ts: Date.now(), stream, line: clean.slice(0, 8000) }) + '\n'
  );
}

let currentPhase = 'starting';
let currentExtra = {};

function writeStatus() {
  write('status.json', { phase: currentPhase, seq: logSeq, updatedAt: Date.now(), ...currentExtra });
}

function setStatus(phase, extra = {}) {
  currentPhase = phase;
  currentExtra = extra;
  writeStatus();
}

/**
 * Heartbeat.
 *
 * Phases can last minutes — `claude-code` routinely does — so a status file
 * that only moves on transitions cannot distinguish "working" from "dead". The
 * Worker's only other recourse was the job's wall-clock timeout, which meant a
 * runner that died silently held the job for thirty minutes.
 *
 * unref'd so it never keeps the process alive past its work.
 */
const heartbeat = setInterval(writeStatus, 5_000);
heartbeat.unref();

// ------------------------------------------------------------ command exec

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated, ${text.length - limit} more characters]`;
}

const steps = [];

/**
 * Run one command, streaming its output into the log.
 *
 * Rejects on failure unless `allowFailure`, which mirrors the previous
 * behaviour: a broken environment should stop the job, but a failing check
 * should not — the diff is still worth having.
 */
function run(name, command, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    log('system', `▶ ${name}`);

    const child = spawn('bash', ['-lc', command], {
      cwd: options.cwd ?? REPO_DIR,
      env: { ...process.env, ...(options.env ?? {}) },
    });

    let output = '';
    const capture = (stream) => (chunk) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split('\n')) log(stream, line);
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));

    const timer = options.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
      : null;

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const step = {
        name,
        command: redact(command),
        exitCode: code ?? 1,
        success: code === 0,
        durationMs: Date.now() - startedAt,
        output: truncate(redact(output), options.maxOutput ?? MAX_STEP_OUTPUT),
      };
      steps.push(step);
      log('system', `${step.success ? '✔' : '✖'} ${name} (exit ${step.exitCode}, ${step.durationMs}ms)`);

      if (!step.success && !options.allowFailure) {
        reject(new Error(`step "${name}" failed with exit code ${step.exitCode}`));
        return;
      }
      resolve(step);
    });

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
  });
}

function skip(name, reason) {
  steps.push({ name, command: '', exitCode: 0, success: true, durationMs: 0, output: reason, skipped: true });
  log('system', `⏭ ${name} — ${reason}`);
}

// -------------------------------------------------------------- the job

async function main() {
  const job = JSON.parse(readFileSync(`${STATE_DIR}/job.json`, 'utf8'));
  const { commands = {}, options = {} } = job;

  setStatus('preparing');
  log('system', `job ${job.id}`);
  log('system', `base branch ${job.baseBranch} → work branch ${job.branch}`);

  // The repository is cloned by the Worker before this starts: cloning needs
  // credentials injected outside the container, which is exactly what this
  // process must never see.

  // Prove no API-key credential is present. `printenv` prints nothing and
  // exits non-zero when the variables are unset.
  const leak = await run('verify-no-api-key', 'printenv ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN', {
    allowFailure: true,
  });
  if (leak.output.trim().length > 0) {
    throw new Error(
      'ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set inside the container. ' +
        'Refusing to run: this environment must use subscription OAuth only.'
    );
  }
  log('system', 'verified: no API-key credential present in the container');

  await run('git-config', `git -C ${REPO_DIR} config user.name ${shellQuote(GIT_USER_NAME)}`);
  await run('git-config-email', `git -C ${REPO_DIR} config user.email ${shellQuote(GIT_USER_EMAIL)}`);
  await run('git-branch', `git -C ${REPO_DIR} checkout -b ${shellQuote(job.branch)}`);

  setStatus('installing');
  if (commands.install) await run('install', commands.install, { timeoutMs: job.stepTimeoutMs });
  else skip('install', 'INSTALL_COMMAND is not configured');

  setStatus('running');
  const claude = await run(
    'claude-code',
    [
      'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;',
      'claude -p',
      shellQuote(job.prompt),
      '--permission-mode bypassPermissions',
      '--append-system-prompt',
      shellQuote(EXTRA_SYSTEM_PROMPT),
    ].join(' '),
    { timeoutMs: job.claudeTimeoutMs }
  );

  setStatus('checking');
  if (options.skipChecks) {
    skip('checks', 'skipChecks was requested for this job');
  } else {
    for (const [name, command] of [
      ['lint', commands.lint],
      ['test', commands.test],
      ['build', commands.build],
    ]) {
      // Check failures are reported, not fatal: the diff is still useful.
      if (command) await run(name, command, { timeoutMs: job.stepTimeoutMs, allowFailure: true });
      else skip(name, `${name.toUpperCase()}_COMMAND is not configured`);
    }
  }

  setStatus('collecting');
  const porcelain = await run('git-status-porcelain', `git -C ${REPO_DIR} status --porcelain`, {
    allowFailure: true,
  });
  const changed = porcelain.output.trim().length > 0;

  let commitSha;
  if (changed) {
    await run('git-add', `git -C ${REPO_DIR} add -A`);
    const message = `${job.prompt.split('\n')[0].slice(0, 68)}\n\nremote-claude job ${job.id}`;
    await run('git-commit', `git -C ${REPO_DIR} commit -m ${shellQuote(message)}`);
    const sha = await run('git-rev-parse', `git -C ${REPO_DIR} rev-parse HEAD`, { allowFailure: true });
    commitSha = sha.output.trim() || undefined;
  } else {
    log('system', 'Claude Code produced no file changes');
  }

  const range = `${shellQuote(job.baseBranch)}..HEAD`;
  const status = await run('git-status', `git -C ${REPO_DIR} status --short --branch`, { allowFailure: true });
  const diffStat = await run('git-diff-stat', `git -C ${REPO_DIR} diff --stat ${range}`, { allowFailure: true });
  const patch = await run('git-diff', `git -C ${REPO_DIR} diff ${range}`, {
    allowFailure: true,
    maxOutput: MAX_PATCH_BYTES,
  });

  const patchText = truncate(patch.output, MAX_PATCH_BYTES);
  patch.output = '(retrieve with GET /jobs/:id/diff)';
  write('patch.diff', patchText);

  write('result.json', {
    claudeOutput: claude.output,
    changed,
    commitSha,
    branch: job.branch,
    pushed: false,
    gitStatus: status.output.trim(),
    diffStat: diffStat.output.trim(),
    diffBytes: patchText.length,
    steps,
  });

  setStatus('completed');
}

main().catch((error) => {
  const message = redact(error instanceof Error ? error.message : String(error));
  log('system', `job failed: ${message}`);
  // The Worker distinguishes failure from "still running" by this file, so it
  // must be written even on the paths that threw.
  write('result.json', { error: message, steps, changed: false, branch: null });
  setStatus('failed', { error: message });
  process.exit(1);
});
