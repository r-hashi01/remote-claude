#!/usr/bin/env node
/**
 * remote-claude — thin client for the Cloudflare-hosted Claude Code runner.
 *
 * I/O-only: it never runs Claude Code, git operations against the working tree
 * (except `apply`), or Docker locally. All compute happens in the Cloudflare
 * Sandbox.
 *
 * Built on the same client package published for everyone else. It used to hand-
 * write its own fetch, which meant this repository's own tool was not the first
 * consumer of the thing this repository ships — and the transient-retry rule
 * ended up living here *and* in the SDK, the recurring defect of one rule in two
 * places. Whatever a consumer would trip over, this trips over first.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Resolved through node_modules, where `file:./sdk` links the in-repo package.
// Reported by hand because a missing build reaches the user as a module
// resolution error naming a path they never typed.
let sdk;
try {
  sdk = await import('@r-hashi01/remote-claude-client');
} catch (error) {
  process.stderr.write(
    'remote-claude: the client package is not built.\n' +
      '  npm install          (builds it as part of installing)\n' +
      '  npm run sdk:build    (rebuilds it on its own)\n' +
      `  ${error.message}\n`
  );
  process.exit(2);
}
const { createClient, isTerminal, ExecutorError } = sdk;

// The CLI is repository-agnostic: it acts on wherever you invoke it from.
const REPO_ROOT = process.cwd();

const USAGE = `
remote-claude — run Claude Code on Cloudflare, not on your Mac

  remote-claude "<prompt>"              start a job and follow it
  remote-claude run "<prompt>" [opts]   same, explicit form
  remote-claude continue <job-id> "<reply>"
                                        answer a finished job and carry on
  remote-claude status <job-id>        show a job's status and summary
  remote-claude logs <job-id> [-f]     print logs (-f/--follow to tail)
  remote-claude terminal <job-id>      watch what the commands print, live
  remote-claude diff <job-id>          print the unified diff
  remote-claude apply <job-id>         apply that diff to the local worktree
  remote-claude cancel <job-id>        cancel a running job
  remote-claude list                    list recent jobs
  remote-claude sandboxes               show what is allocated and not reclaimed
  remote-claude health [--auth]         check the worker (and Claude auth)

Options for run:
  --repo <url>      repository to work on (default: worker's REPO_URL)
  --base <branch>   base branch (default: worker's DEFAULT_BASE_BRANCH)
  --branch <name>   work on this branch instead of a generated one
  --model <name>    model for this job: opus | sonnet | haiku | a model id
                    (default: the worker's CLAUDE_MODEL, else Claude Code's own)
  --install <cmd>   install command for this job (see below)
  --lint <cmd>      lint command for this job
  --test <cmd>      test command for this job
  --build <cmd>     build command for this job
  --no-follow       return immediately after printing the task id
  --skip-checks     skip lint/test/build
  --push            push the branch (requires ALLOW_PUSH=true on the worker)
  --pr              push and open a pull request (implies --push)
  --keep            leave the sandbox alive for inspection
  --json            machine-readable output

The four command options matter most with --repo: a deployment's commands were
written for the repository it is configured with, and install runs even when
--skip-checks is set. Pass an empty string to skip one: --install ''.

Configuration (first match wins):
  env  REMOTE_CLAUDE_URL / REMOTE_CLAUDE_TOKEN
  file ./.remote-claude.json
  file ~/.config/remote-claude/config.json
`.trim();


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

// ---------------------------------------------------------------- client

/**
 * How long between polls while following a job.
 *
 * Tighter than the SDK's two-second default because a person is watching this
 * one. How many failures in a row are survivable, and which failures count, is
 * the SDK's to decide — that rule was written here as well until this file
 * stopped hand-writing its own transport.
 */
const FOLLOW_INTERVAL_MS = 1_500;

/** The one place a transport failure becomes something a person reads. */
function reportFailure(error) {
  if (error instanceof ExecutorError && error.status === 401) {
    fail('unauthorized — REMOTE_CLAUDE_TOKEN does not match the worker');
  }
  fail(error.message);
}

// -------------------------------------------------------------- commands

/**
 * Every field of the SDK's `StartJob`, and how this CLI spells it.
 *
 * Stated rather than implied, because three capabilities — naming a repository,
 * continuing a job, supplying the commands — existed in the API and the SDK and
 * not here, and nothing said so. A test in src/conventions.test.ts fails when the
 * SDK grows a field this map does not mention.
 */
const RUN_OPTIONS = {
  prompt: 'the positional argument',
  repo: '--repo',
  baseBranch: '--base',
  branch: '--branch',
  commands: '--install / --lint / --test / --build',
  skipChecks: '--skip-checks',
  keepSandbox: '--keep',
  push: '--push',
  pullRequest: '--pr',
  model: '--model',
};

/** The same for a follow-up turn, which inherits the repository and branch. */
const CONTINUE_OPTIONS = {
  prompt: 'the positional argument',
  commands: '--install / --lint / --test / --build',
  skipChecks: '--skip-checks',
  keepSandbox: '--keep',
  push: '--push',
  pullRequest: '--pr',
  // A turn may switch models — a cheap follow-up on work a larger model did, or
  // the reverse when the first answer was not good enough. Unspecified keeps the
  // model the previous turn ran.
  model: '--model',
};

/**
 * The four command overrides, as the API wants them.
 *
 * Absent keys inherit the deployment's, so an option nobody passed must not
 * appear at all — `{ install: undefined }` and `{}` do not mean the same thing to
 * a caller who wants the deployment's install command.
 */
function commandsFrom(opts) {
  const given = ['install', 'lint', 'test', 'build'].filter((name) => opts[name] !== undefined);
  if (given.length === 0) return undefined;
  return Object.fromEntries(given.map((name) => [name, opts[name]]));
}

async function cmdRun(client, args) {
  const opts = parseArgs(args, {
    flags: ['no-follow', 'skip-checks', 'push', 'pr', 'keep', 'json'],
    values: ['base', 'repo', 'branch', 'model', 'install', 'lint', 'test', 'build'],
  });
  const prompt = opts._.join(' ').trim();
  if (!prompt) fail('a prompt is required\n\n' + USAGE);

  const created = await client.startJob({
    prompt,
    // Accepted by the API and offered by the SDK, and missing here — so a job
    // aimed at anything but the deployment's own REPO_URL was silently run
    // against that instead. Which repositories may be named is the GitHub App
    // installation's answer, not this flag's (ADR 0010).
    repo: opts.repo,
    baseBranch: opts.base,
    branch: opts.branch,
    // Absent leaves the choice to the deployment, which is the right default:
    // most jobs do not care, and the ones that do care a lot.
    model: opts.model,
    commands: commandsFrom(opts),
    skipChecks: opts['skip-checks'],
    push: opts.push,
    // Left to the executor to compose the title and body: it knows the prompt
    // and, by the time it opens one, what its own checks reported.
    ...(opts.pr ? { pullRequest: {} } : {}),
    keepSandbox: opts.keep,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(created) + '\n');
    if (opts['no-follow']) return 0;
  } else {
    log(`job ${created.id} → branch ${created.branch}`);
    if (opts['no-follow']) {
      log(`follow with:  remote-claude logs ${created.id} -f`);
      return 0;
    }
    log('');
  }

  const final = await follow(client, created.id, !opts.json);
  if (!opts.json) printSummary(final, created.id);
  else process.stdout.write(JSON.stringify(final) + '\n');

  return final.status === 'completed' ? 0 : 1;
}

/**
 * Print a job's log as it appears, and return the job once it is done.
 *
 * The loop itself belongs to the SDK: advancing the cursor only on a page that
 * had lines, reading the tail once more after the status turns terminal, and
 * surviving the 500 a deploy produces while the container carries on regardless.
 * All of that was written here too, from the same bug reports.
 */
function follow(client, id, echo) {
  return client.waitForJob(id, {
    intervalMs: FOLLOW_INTERVAL_MS,
    onLog: echo
      ? (lines) => {
          for (const entry of lines) {
            const prefix =
              entry.stream === 'stderr' ? '! ' : entry.stream === 'system' ? '· ' : '  ';
            process.stdout.write(prefix + entry.line + '\n');
          }
        }
      : undefined,
    onTransientError: (error, consecutive) =>
      process.stderr.write(`· ${error.message} — retrying (${consecutive})\n`),
  });
}

/**
 * Answer a job and let it carry on from where it stopped.
 *
 * The case a one-shot job cannot handle: the agent stopped to ask something. The
 * turn restores that job's workspace and resumes its conversation (ADR 0011), so
 * a reply of "A で行こう" lands where the question was asked instead of at the
 * start of a fresh job that has never heard of A.
 *
 * Offered by the API and by the SDK, and missing here — so the one client in this
 * repository could start jobs and never answer them.
 */
async function cmdContinue(client, args) {
  const opts = parseArgs(args, {
    flags: ['no-follow', 'skip-checks', 'push', 'pr', 'keep', 'json'],
    values: ['model', 'install', 'lint', 'test', 'build'],
  });
  const [previousId, ...rest] = opts._;
  if (!previousId) fail('a job id is required: remote-claude continue <job-id> "<reply>"');
  const prompt = rest.join(' ').trim();
  if (!prompt) fail('a reply is required — this is a turn in a conversation');

  const created = await client.continueJob(previousId, {
    prompt,
    model: opts.model,
    commands: commandsFrom(opts),
    skipChecks: opts['skip-checks'],
    push: opts.push,
    ...(opts.pr ? { pullRequest: {} } : {}),
    keepSandbox: opts.keep,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(created) + '\n');
    if (opts['no-follow']) return 0;
  } else {
    log(`job ${created.id} continues ${previousId} → branch ${created.branch}`);
    if (opts['no-follow']) {
      log(`follow with:  remote-claude logs ${created.id} -f`);
      return 0;
    }
    log('');
  }

  const final = await follow(client, created.id, !opts.json);
  if (!opts.json) printSummary(final, created.id);
  else process.stdout.write(JSON.stringify(final) + '\n');

  return final.status === 'completed' ? 0 : 1;
}

/**
 * Watch a run the way you would watch a build in a terminal you left open.
 *
 * The other half of `logs`. That one prints parsed lines and answers where a run
 * is up to; this prints the bytes the commands produced, as they produce them,
 * and answers what is happening. Every run that went wrong turned out to be
 * legible only here.
 */
async function cmdTerminal(client, args) {
  const opts = parseArgs(args, { flags: [], values: ['from'] });
  const id = opts._[0];
  if (!id) fail('a job id is required');

  const outcome = await client.followOutput(id, {
    ...(opts.from === undefined ? {} : { offset: Number.parseInt(opts.from, 10) || 0 }),
    onStart: (offset, skipped) =>
      log(skipped > 0 ? `— joined at byte ${offset}, ${skipped} earlier bytes skipped —` : ''),
    onChunk: (text) => process.stdout.write(text),
  });

  log('');
  log(`job ${outcome.status} (${outcome.offset} bytes)`);
  return outcome.status === 'completed' ? 0 : 1;
}

async function cmdStatus(client, args) {
  const id = requireId(args);
  const task = await client.getJob(id);
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(task, null, 2) + '\n');
    return 0;
  }
  printSummary(task, id);
  return isTerminal(task.status) && task.status !== 'completed' ? 1 : 0;
}

async function cmdLogs(client, args) {
  const id = requireId(args);
  if (args.includes('-f') || args.includes('--follow')) {
    await follow(client, id, true);
    return 0;
  }
  // Paged rather than asking the executor for one text blob: the same call the
  // follow path uses, so there is one way logs are fetched and one place a
  // change to that has to land.
  for (let since = 0; ; ) {
    const page = await client.getLogs(id, since);
    if (page.logs.length === 0) break;
    for (const entry of page.logs) process.stdout.write(entry.line + '\n');
    since = page.nextSince;
  }
  return 0;
}

/**
 * The dashboard that used to be here.
 *
 * Kept as a stub because a bare first argument is a prompt: without this, typing
 * the old command starts a job whose prompt is the word "ui". Which is exactly
 * what happened while removing it.
 */
async function cmdUi() {
  log('the local dashboard was removed (ADR 0015).');
  log('');
  log('  remote-claude terminal <job-id>   watch a run as it happens');
  log('  remote-claude logs <job-id> -f    the same run as parsed lines');
  return 2;
}

async function cmdDiff(client, args) {
  const id = requireId(args);
  const patch = (await client.getDiff(id)) ?? '';
  if (!patch.trim()) {
    log('(no changes)');
    return 1;
  }
  process.stdout.write(patch);
  return 0;
}

async function cmdApply(client, args) {
  const id = requireId(args);
  const patch = (await client.getDiff(id)) ?? '';
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

async function cmdCancel(client, args) {
  const id = requireId(args);
  await client.cancelJob(id);
  log(`job ${id}: cancelled`);
  return 0;
}

async function cmdList(client) {
  const tasks = await client.listJobs(20);
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

async function cmdSandboxes(client) {
  const ledger = await client.listSandboxes();
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

async function cmdHealth(client, args) {
  const ok = await client.health();
  log(`worker: ${ok ? 'ok' : 'unhealthy'}`);
  if (args.includes('--auth')) {
    log('probing Claude auth (starts a container, ~30s) …');
    const auth = await client.checkAuth();
    log(`claude auth: ${auth.ok ? 'ok' : 'FAILED'} (mode=${auth.authMode}, scheme=${auth.authScheme})`);
    // `reason` is present exactly when there was nothing to probe — no
    // credential, or two of them — and then there is no model to report either.
    if (auth.reason) log(`  ${auth.reason}`);
    // Which credential answered is the point of asking, and the model beside it
    // is the other thing about a deployment nothing else reports.
    else log(`model:       ${auth.model ?? 'claude-code default'}`);
    if (auth.output) log(`  ${auth.output}`);
    return auth.ok ? 0 : 1;
  }
  return ok ? 0 : 1;
}

// --------------------------------------------------------------- helpers

function printSummary(task, id) {
  log('');
  log(`status   ${task.status}`);
  if (task.error) log(`error    ${task.error}`);
  // Only when this job chose one. Absent means the deployment's, which is a
  // question about the deployment rather than about this job — `health --auth`.
  if (task.model) log(`model    ${task.model}`);
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
  // The one line that lets somebody without this CLI see the work.
  if (task.pullRequestUrl) log(`pr       ${task.pullRequestUrl}`);
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
  if (result.changed && !task.pullRequestUrl) {
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
  continue: cmdContinue,
  status: cmdStatus,
  logs: cmdLogs,
  terminal: cmdTerminal,
  ui: cmdUi,
  diff: cmdDiff,
  apply: cmdApply,
  cancel: cmdCancel,
  list: cmdList,
  sandboxes: cmdSandboxes,
  health: cmdHealth,
};

const config = loadConfig();
const client = createClient(config);
// A bare prompt is shorthand for `run`.
const [handler, args] = COMMANDS[first] ? [COMMANDS[first], rest] : [cmdRun, [first, ...rest]];

try {
  process.exit((await handler(client, args)) ?? 0);
} catch (error) {
  reportFailure(error);
}
