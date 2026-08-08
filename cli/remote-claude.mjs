#!/usr/bin/env node
/**
 * remote-claude — thin client for the Cloudflare-hosted Claude Code runner.
 *
 * Deliberately dependency-free and I/O-only: it never runs Claude Code, git
 * operations against the working tree (except `apply`), or Docker locally.
 * All compute happens in the Cloudflare Sandbox.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

// The CLI is repository-agnostic: it acts on wherever you invoke it from.
const REPO_ROOT = process.cwd();

const USAGE = `
remote-claude — run Claude Code on Cloudflare, not on your Mac

  remote-claude "<prompt>"              start a job and follow it
  remote-claude run "<prompt>" [opts]   same, explicit form
  remote-claude status <job-id>        show a job's status and summary
  remote-claude logs <job-id> [-f]     print logs (-f/--follow to tail)
  remote-claude diff <job-id>          print the unified diff
  remote-claude apply <job-id>         apply that diff to the local worktree
  remote-claude cancel <job-id>        cancel a running job
  remote-claude list                    list recent jobs
  remote-claude sandboxes               show what is allocated and not reclaimed
  remote-claude health [--auth]         check the worker (and Claude auth)

Options for run:
  --base <branch>   base branch (default: worker's DEFAULT_BASE_BRANCH)
  --no-follow       return immediately after printing the task id
  --skip-checks     skip lint/test/build
  --push            push the branch (requires ALLOW_PUSH=true on the worker)
  --keep            leave the sandbox alive for inspection
  --json            machine-readable output

Configuration (first match wins):
  env  REMOTE_CLAUDE_URL / REMOTE_CLAUDE_TOKEN
  file ./.remote-claude.json
  file ~/.config/remote-claude/config.json
`.trim();

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

// ---------------------------------------------------------------- config

/**
 * Where to look for `url` and `token`, in order:
 *   1. the current directory and every parent, so a repository can pin its own
 *   2. ~/.config/remote-claude/config.json
 *
 * The walk upwards matters because the CLI acts on whatever repository you are
 * standing in, and you are rarely standing exactly at its root. The global file
 * is the normal place for these: they identify a deployment, not a repository.
 */
function configCandidates() {
  const paths = [];
  let dir = process.cwd();
  for (;;) {
    paths.push(join(dir, '.remote-claude.json'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  paths.push(join(homedir(), '.config', 'remote-claude', 'config.json'));
  return paths;
}

function loadConfig() {
  let fromFile = {};
  for (const path of configCandidates()) {
    try {
      fromFile = JSON.parse(readFileSync(path, 'utf8'));
      break;
    } catch {
      /* try the next one */
    }
  }

  const url = process.env.REMOTE_CLAUDE_URL || fromFile.url;
  const token = process.env.REMOTE_CLAUDE_TOKEN || fromFile.token;

  if (!url || !token) {
    fail(
      'missing configuration.\n\n' +
        'Set REMOTE_CLAUDE_URL and REMOTE_CLAUDE_TOKEN, or create\n' +
        '  ~/.config/remote-claude/config.json\n' +
        '  { "url": "https://remote-claude.<subdomain>.workers.dev", "token": "<REMOTE_CLAUDE_TOKEN>" }\n\n' +
        'A .remote-claude.json in the current directory or any parent takes\n' +
        'precedence. Never commit the token; keep the file mode at 600.'
    );
  }
  return { url: url.replace(/\/+$/, ''), token };
}

// ------------------------------------------------------------------ http

async function api(config, path, { method = 'GET', body, raw = false } = {}) {
  let response;
  try {
    response = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    fail(`cannot reach ${config.url}: ${error.message}`);
  }

  if (response.status === 401) fail('unauthorized — REMOTE_CLAUDE_TOKEN does not match the worker');
  if (response.status === 404) fail('not found');

  if (raw) {
    const text = await response.text();
    if (!response.ok) fail(text || `HTTP ${response.status}`);
    return text;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(payload.error || `HTTP ${response.status}`);
  return payload;
}

// -------------------------------------------------------------- commands

async function cmdRun(config, args) {
  const opts = parseArgs(args, {
    flags: ['no-follow', 'skip-checks', 'push', 'keep', 'json'],
    values: ['base'],
  });
  const prompt = opts._.join(' ').trim();
  if (!prompt) fail('a prompt is required\n\n' + USAGE);

  const created = await api(config, '/jobs', {
    method: 'POST',
    body: {
      prompt,
      baseBranch: opts.base,
      skipChecks: opts['skip-checks'],
      push: opts.push,
      keepSandbox: opts.keep,
    },
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(created) + '\n');
    if (opts['no-follow']) return 0;
  } else {
    log(`job ${created.jobId} → branch ${created.branch}`);
    if (opts['no-follow']) {
      log(`follow with:  remote-claude logs ${created.jobId} -f`);
      return 0;
    }
    log('');
  }

  const final = await follow(config, created.jobId, !opts.json);
  if (!opts.json) printSummary(final, created.jobId);
  else process.stdout.write(JSON.stringify(final) + '\n');

  return final.status === 'completed' ? 0 : 1;
}

async function follow(config, id, echo) {
  let since = 0;
  for (;;) {
    const { logs, nextSince } = await api(config, `/jobs/${id}/logs?since=${since}`);
    since = nextSince ?? since;
    if (echo) {
      for (const entry of logs) {
        const prefix = entry.stream === 'stderr' ? '! ' : entry.stream === 'system' ? '· ' : '  ';
        process.stdout.write(prefix + entry.line + '\n');
      }
    }

    const task = await api(config, `/jobs/${id}`);
    if (TERMINAL.has(task.status)) {
      // Drain anything written between the two calls.
      const tail = await api(config, `/jobs/${id}/logs?since=${since}`);
      if (echo) for (const entry of tail.logs) process.stdout.write('  ' + entry.line + '\n');
      return task;
    }
    await sleep(logs.length > 0 ? 400 : 1500);
  }
}

async function cmdStatus(config, args) {
  const id = requireId(args);
  const task = await api(config, `/jobs/${id}`);
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(task, null, 2) + '\n');
    return 0;
  }
  printSummary(task, id);
  return TERMINAL.has(task.status) && task.status !== 'completed' ? 1 : 0;
}

async function cmdLogs(config, args) {
  const id = requireId(args);
  if (args.includes('-f') || args.includes('--follow')) {
    await follow(config, id, true);
    return 0;
  }
  const text = await api(config, `/jobs/${id}/logs?format=text`, { raw: true });
  process.stdout.write(text + '\n');
  return 0;
}

async function cmdDiff(config, args) {
  const id = requireId(args);
  const patch = await api(config, `/jobs/${id}/diff`, { raw: true });
  if (!patch.trim()) {
    log('(no changes)');
    return 1;
  }
  process.stdout.write(patch);
  return 0;
}

async function cmdApply(config, args) {
  const id = requireId(args);
  const patch = await api(config, `/jobs/${id}/diff`, { raw: true });
  if (!patch.trim()) {
    log('(no changes to apply)');
    return 1;
  }

  const check = args.includes('--check') ? ['--check'] : [];
  const code = await pipeToGit(['apply', '--3way', ...check], patch);
  if (code === 0) log(check.length ? 'patch applies cleanly' : `applied job ${id} to the working tree`);
  else log('git apply failed — inspect with: remote-claude diff ' + id);
  return code;
}

function pipeToGit(argv, input) {
  return new Promise((resolve) => {
    const child = spawn('git', argv, { cwd: REPO_ROOT, stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end(input);
    child.on('close', resolve);
    child.on('error', () => resolve(1));
  });
}

async function cmdCancel(config, args) {
  const id = requireId(args);
  const result = await api(config, `/jobs/${id}/cancel`, { method: 'POST' });
  log(`job ${result.jobId}: ${result.status}`);
  return 0;
}

async function cmdList(config) {
  const { tasks } = await api(config, '/jobs?limit=20');
  if (tasks.length === 0) {
    log('no jobs yet');
    return 0;
  }
  for (const task of tasks) {
    const when = new Date(task.createdAt).toISOString().replace('T', ' ').slice(0, 16);
    const title = task.prompt.split('\n')[0].slice(0, 52);
    log(`${task.id}  ${task.status.padEnd(9)}  ${when}  ${title}`);
  }
  return 0;
}

async function cmdSandboxes(config) {
  const ledger = await api(config, '/sandboxes');
  log(`outstanding ${ledger.outstanding.length}   reclaimed ${ledger.destroyed}   running ${ledger.running.length}`);

  if (ledger.outstanding.length === 0) {
    log('nothing outstanding');
    return 0;
  }

  log('');
  for (const entry of ledger.outstanding) {
    const age = Math.round((Date.now() - entry.createdAt) / 1000);
    const executing = ledger.running.includes(entry.jobId) ? ' (job running)' : '';
    log(`${entry.id}  age ${age}s  attempts ${entry.attempts}${executing}`);
    if (entry.lastError) log(`  last error: ${entry.lastError}`);
  }

  // Outstanding entries for jobs that are no longer running are leaks.
  const leaked = ledger.outstanding.filter((entry) => !ledger.running.includes(entry.jobId));
  return leaked.length > 0 ? 1 : 0;
}

async function cmdHealth(config, args) {
  const health = await api(config, '/health');
  log(`worker: ${health.ok ? 'ok' : 'unhealthy'}`);
  if (args.includes('--auth')) {
    log('probing Claude subscription auth (starts a container, ~30s) …');
    const auth = await api(config, '/health/auth');
    log(`claude auth: ${auth.ok ? 'ok' : 'FAILED'} (mode=${auth.authMode}, scheme=${auth.authScheme})`);
    if (auth.output) log(`  ${auth.output}`);
    return auth.ok ? 0 : 1;
  }
  return health.ok ? 0 : 1;
}

// --------------------------------------------------------------- helpers

function printSummary(task, id) {
  log('');
  log(`status   ${task.status}`);
  if (task.error) log(`error    ${task.error}`);
  if (task.usage) {
    const cost = typeof task.usage.costUsd === 'number' ? `, $${task.usage.costUsd.toFixed(4)}` : '';
    const turns = task.usage.turns ? `, ${task.usage.turns} turns` : '';
    log(`usage    ${task.usage.inputTokens} in / ${task.usage.outputTokens} out${turns}${cost}`);
  }
  const result = task.result;
  if (!result) {
    log(`(no result yet — remote-claude logs ${id})`);
    return;
  }
  log(`branch   ${result.branch}${result.pushed ? ' (pushed)' : ''}`);
  log(`changed  ${result.changed ? 'yes' : 'no'}${result.commitSha ? ` (${result.commitSha.slice(0, 8)})` : ''}`);

  const interesting = (result.steps || []).filter((s) => ['lint', 'test', 'build'].includes(s.name));
  for (const step of interesting) {
    const mark = step.skipped ? 'skip' : step.success ? 'ok' : 'FAIL';
    log(`${step.name.padEnd(8)} ${mark}`);
  }

  if (result.diffStat) {
    log('');
    for (const line of result.diffStat.split('\n')) log('  ' + line);
  }
  // The agent's closing message, not `result.claudeOutput` — that is the raw
  // stream-json event stream, which is for debugging, not for reading.
  if (task.finalText) {
    log('');
    log('--- claude ---');
    log(task.finalText.trim().slice(0, 4000));
  }
  if (result.changed) {
    log('');
    log(`apply locally:  remote-claude apply ${id}`);
  }
}

function parseArgs(argv, { flags = [], values = [] }) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (flags.includes(name)) out[name] = true;
      else if (values.includes(name)) out[name] = argv[++i];
      else fail(`unknown option: ${arg}`);
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function requireId(args) {
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) fail('a job id is required');
  return id;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stderr.write(message + '\n');

function fail(message) {
  process.stderr.write(`remote-claude: ${message}\n`);
  process.exit(2);
}

// ------------------------------------------------------------------ main

const [, , first, ...rest] = process.argv;

if (!first || first === '--help' || first === '-h' || first === 'help') {
  process.stderr.write(USAGE + '\n');
  process.exit(first ? 0 : 2);
}

const COMMANDS = {
  run: cmdRun,
  status: cmdStatus,
  logs: cmdLogs,
  diff: cmdDiff,
  apply: cmdApply,
  cancel: cmdCancel,
  list: cmdList,
  sandboxes: cmdSandboxes,
  health: cmdHealth,
};

const config = loadConfig();
// A bare prompt is shorthand for `run`.
const [handler, args] = COMMANDS[first] ? [COMMANDS[first], rest] : [cmdRun, [first, ...rest]];

process.exit((await handler(config, args)) ?? 0);
