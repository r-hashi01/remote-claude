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
 *   output.raw    append-only; what a terminal attached to this would have shown
 *   status.json   current phase; rewritten as it changes
 *   result.json   written once, on completion
 *   patch.diff    written once, on completion
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STATE_DIR = process.argv[2] ?? '/var/lib/remote-claude';
const REPO_DIR = process.env.REPO_DIR ?? '/workspace/repo';

/**
 * Where npm keeps what it has already downloaded.
 *
 * Inside the workspace, because that is the directory the Worker can store and put
 * back between jobs (ADR 0016) — and pointed at from here rather than from the
 * install command, so every step shares it: the agent's own `npm install` should
 * not go to the network for something this job already has.
 *
 * Set on the process, so children inherit it. The first version set it nowhere and
 * npm used its default: the Worker then tried to store a directory that did not
 * exist, and said so — but only to the log of the job that had already finished.
 *
 * The image's own cache is carried over the first time rather than abandoned. A
 * fresh container already answers a hundred-odd packages from what building the
 * image downloaded — the first measurement showed 104 hits against 78 misses — and
 * simply pointing npm elsewhere would throw that away on every repository's first
 * job. Hard links where the filesystem allows it, so carrying it costs nothing.
 */
const PACKAGE_CACHE = '/workspace/.npm-cache';

function inheritImageCache() {
  const fromImage = join(process.env.HOME ?? '/root', '.npm');
  if (existsSync(PACKAGE_CACHE) || !existsSync(fromImage)) return;

  for (const flags of [['-al'], ['-a']]) {
    const copy = spawnSync('cp', [...flags, fromImage, PACKAGE_CACHE], { stdio: 'ignore' });
    if (copy.status === 0) return;
  }
}

// Nothing here may take a job down. This runs before `main`, so a throw would land
// outside the handler that writes `result.json` — the job would end with no record
// of why, which is the one failure mode this pipeline is built to avoid. The worst
// case of a failed inherit is an install that fetches, which is what it did before
// any of this existed.
try {
  inheritImageCache();
} catch {
  // Reported by its absence: the install below will say `cache miss` for everything.
}
process.env.npm_config_cache = PACKAGE_CACHE;

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

/**
 * What a terminal attached to this pipeline would have shown.
 *
 * Written beside log.ndjson rather than instead of it, because the two answer
 * different questions: the NDJSON says *where a run is up to* — one object per
 * line, with the step markers and the stream it came from — and this says *what
 * is happening*, in the bytes the commands actually produced, unsplit and
 * untruncated.
 *
 * Watching a run is the case that has no answer today. A run that spent twenty
 * minutes looping, one that died at install with ECONNRESET — which is now retried
 * rather than fatal — one that went quiet for four minutes: each was legible only
 * from the output, and only after the fact.
 *
 * Unbounded, on purpose.
 *
 * It was capped at eight megabytes, and the cap was aimed at the wrong risk. This
 * is `appendFileSync` to the container's own disk, not memory — the in-memory copy
 * a step keeps is `output`, which is truncated separately and always was. What the
 * cap actually bought was a truncated terminal on precisely the runs worth
 * watching: a long one. Reading a window of a file costs the same whatever the
 * file's length, so the size only matters to the disk, and the disk is the
 * container's to spend on this.
 *
 * The rate is knowable rather than mysterious: the agent's event stream runs at
 * roughly thirty kilobytes per two seconds of tool use, so an hour of solid
 * agent work is tens of megabytes. If that ever becomes the constraint, the answer
 * is a rolling window that keeps the tail — not a cliff that stops recording and
 * leaves the end of a run, which is the part with the outcome in it, missing.
 */
function raw(text) {
  appendFileSync(`${STATE_DIR}/output.raw`, redact(text));
}

let logSeq = 0;
function log(stream, line) {
  const clean = redact(line);
  if (!clean.trim()) return;
  // Markers belong in the terminal view too: they are how a watcher knows which
  // step the output underneath belongs to.
  if (stream === 'system') raw(`${clean}\n`);
  logSeq += 1;
  appendFileSync(
    `${STATE_DIR}/log.ndjson`,
    JSON.stringify({ seq: logSeq, ts: Date.now(), stream, line: clean.slice(0, 8000) }) + '\n'
  );
}

// ---------------------------------------------------------------- memory

/**
 * How much of the container's memory allowance is in use.
 *
 * A runner that is killed for using too much cannot report it afterwards: the
 * process is gone, the platform stops holding a record of it, and the Worker
 * sees only silence — which is indistinguishable from the container itself being
 * taken away, and wants the opposite response. So the trail has to be laid down
 * beforehand.
 *
 * The cgroup is the only honest source here. `os.totalmem()` reports the host's
 * memory inside a container, which is a number roughly eight times too large and
 * far more misleading than having none.
 */
function memoryUse() {
  try {
    const limit = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    const used = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
    if (limit === 'max' || !Number.isFinite(used)) return null;
    return { usedMb: Math.round(used / 1e6), limitMb: Math.round(Number(limit) / 1e6) };
  } catch {
    return null;
  }
}

/**
 * The highest tenth of the allowance already reported.
 *
 * Logged in bands so a healthy job says nothing and a dying one leaves a ladder
 * ending at the last rung it reached — enough to tell "killed for its memory"
 * from "the platform reclaimed the container" without a byte of noise in between.
 */
let reportedBand = 0.6;

function noticeMemory() {
  const use = memoryUse();
  if (!use || !use.limitMb) return use;
  const share = use.usedMb / use.limitMb;
  if (share <= reportedBand + 0.1) return use;
  reportedBand = Math.floor(share * 10) / 10;
  log(
    'system',
    `⚠ memory ${use.usedMb}MB of ${use.limitMb}MB (${Math.round(share * 100)}%) during "${currentPhase}"`
  );
  return use;
}

let currentPhase = 'starting';
let currentExtra = {};

function writeStatus() {
  write('status.json', {
    phase: currentPhase,
    seq: logSeq,
    updatedAt: Date.now(),
    memory: noticeMemory() ?? undefined,
    ...currentExtra,
  });
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

/**
 * Record one raw agent event.
 *
 * Deliberately not interpreted here. Turning these into something a human reads
 * is the Worker's job, which owns that translator — writing a second one here
 * would mean two things to keep in agreement for no benefit. This side emits
 * facts; the other side decides what they mean.
 */
let agentEvents = 0;

function emitAgentEvent(line) {
  agentEvents += 1;
  logSeq += 1;
  appendFileSync(
    `${STATE_DIR}/log.ndjson`,
    JSON.stringify({ seq: logSeq, ts: Date.now(), stream: 'agent', line: line.slice(0, 60000) }) + '\n'
  );
}

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
 * How long a step may produce nothing before the runner says so.
 *
 * The Worker kills a job whose log has been quiet for eight minutes. That rule
 * was right that silence is suspicious and wrong about what silence meant: an
 * `npm install`, or one long tool call inside `claude`, emits nothing for as
 * long as it takes — and one of those took a job with it. Whether a step is
 * still running is a fact this side has and the Worker does not, so say it
 * rather than leaving the Worker to infer it from an absence.
 *
 * This does not weaken the stall rule, it corrects what the rule measures.
 * Silence now means the runner itself has stopped, which is the anomaly the
 * rule was written for. A step that hangs forever is still bounded by its own
 * timeout and by the job's wall clock.
 */
const STEP_SILENCE_NOTICE_MS = 60_000;

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
      // Nothing in this pipeline reads input, and an open stdin pipe is not
      // free: `claude -p` waits 3 seconds for it and then prints a warning into
      // the output stream it is otherwise using for NDJSON events. Closing it
      // here says what is true — there is no input — for every step at once.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let partial = '';
    let lastOutputAt = startedAt;
    const capture = (stream) => (chunk) => {
      lastOutputAt = Date.now();
      const text = chunk.toString();
      output += text;
      /*
       * Everything, as it arrives: no line splitting, no truncation, no exception.
       *
       * The agent's own event stream used to be held back from here on the
       * grounds that thirty kilobytes of NDJSON answers "what is happening" worse
       * than the translated lines do. Two things were wrong with that. It left the
       * terminal view empty for the whole agent step — the longest part of a run
       * and the part somebody is actually watching — and it did so silently,
       * because the liveness notice meant to stand in for it was suppressed by the
       * very output it was standing in for: this line refreshed on stdout that was
       * never written.
       *
       * And the premise was wrong too. Watching a run is not reading a report; the
       * value is in the movement. Raw output moving is what a terminal is, and it
       * is worth more than a tidy summary that arrives at the end.
       *
       * The translated lines still exist for readers who want the report — the
       * Worker builds them from the same stdout, into the parsed log.
       */
      raw(text);

      // Only stdout carries the agent's event stream. stderr is warnings and
      // diagnostics — routing it through the same path made non-JSON lines look
      // like agent events, which the consumer then failed to parse.
      if (options.onLine && stream === 'stdout') {
        // NDJSON arrives in arbitrary chunks; only hand over complete lines.
        partial += text;
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) options.onLine(line);
        return;
      }

      for (const line of text.split('\n')) log(stream, line);
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));

    const timer = options.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
      : null;

    // Checked more often than it fires, so the notice lands close to the
    // minute rather than up to a minute late.
    const silenceNotice = setInterval(() => {
      if (Date.now() - lastOutputAt < STEP_SILENCE_NOTICE_MS) return;
      lastOutputAt = Date.now();
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      // A step whose output is the agent's event stream is never silent to this
      // side and always silent to a terminal, so say what it has done rather than
      // that it has done nothing. A count is not an interpretation.
      const doing = options.onLine ? `${agentEvents} agent events` : 'no output yet';
      log('system', `⋯ ${name} still running (${seconds}s, ${doing})`);
    }, 15_000);
    silenceNotice.unref();

    const settle = () => {
      if (timer) clearTimeout(timer);
      clearInterval(silenceNotice);
    };

    child.on('close', (code) => {
      settle();
      const step = {
        name,
        command: redact(command),
        exitCode: code ?? 1,
        success: code === 0,
        durationMs: Date.now() - startedAt,
        output: truncate(redact(output), options.maxOutput ?? MAX_STEP_OUTPUT),
      };
      // `record: false` leaves the decision to a caller that may run this again —
      // a step is one entry in the pipeline, however many attempts it took.
      if (options.record !== false) steps.push(step);
      log('system', `${step.success ? '✔' : '✖'} ${name} (exit ${step.exitCode}, ${step.durationMs}ms)`);

      if (options.record === false) {
        resolve(step);
        return;
      }

      if (!step.success && !options.allowFailure) {
        reject(new Error(`step "${name}" failed with exit code ${step.exitCode}`));
        return;
      }
      resolve(step);
    });

    child.on('error', (error) => {
      settle();
      reject(error);
    });
  });
}

/**
 * Failures that are the network's, not the job's.
 *
 * A job died at `install` with ECONNRESET, which is nobody's decision and the
 * worst possible timing: install runs before the agent, so the job failed without
 * a conversation — and a job with no conversation cannot be continued either. The
 * whole run was lost to a reset socket.
 *
 * npm retries its own fetches twice; anything reaching here has already outlived
 * that. Matching on the output rather than the exit code because the exit code of
 * a failed `npm ci` says only that it failed.
 */
const TRANSIENT_NETWORK = [
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ESOCKETTIMEDOUT/,
  /ERR_SOCKET_TIMEOUT/,
  /EAI_AGAIN/,
  /ENETUNREACH/,
  /EHOSTUNREACH/,
  /ECONNREFUSED/,
  /socket hang up/i,
  /network (?:timeout|error)/i,
  /request to \S+ failed/i,
  /\b(?:429|502|503|504)\b.*(?:registry|gateway|unavailable|too many)/i,
];

function transientNetworkFailure(output) {
  const matched = TRANSIENT_NETWORK.find((pattern) => pattern.test(output));
  return matched ? (output.match(matched)?.[0] ?? 'a network failure').slice(0, 60) : null;
}

/** How long to wait before trying again. Short, then long enough to matter. */
const RETRY_BACKOFF_MS = [2_000, 8_000];

/**
 * How to fetch, per attempt, when the failure is throughput rather than luck.
 *
 * The evidence said so. Five failures, all mid-transfer, all after a long stretch
 * with no output — 75s, 105s — and in two flavours: the connection cut
 * (ECONNRESET) or nothing coming back (ETIMEDOUT). Small packages never failed;
 * they report progress before the cliff. And the successes took 56s, 78s, 111s,
 * which is not a healthy distribution — it is the same transfer finishing just
 * inside the limit.
 *
 * npm opens fifteen sockets at once by default. Through a narrow path that is
 * fifteen streams each too slow to keep its socket alive, so the timeouts fire on
 * a connection that is working, only slowly. Retrying that shape reaches the same
 * cliff; the shape is what has to change.
 *
 * Set through the environment rather than by editing the command, because the
 * command belongs to the deployment or the job. npm reads `npm_config_*`; anything
 * that is not npm ignores them.
 */
const FETCH_SHAPES = [
  { npm_config_maxsockets: '8' },
  { npm_config_maxsockets: '3' },
  { npm_config_maxsockets: '1' },
];

/** Applies to every attempt: patience is not the variable being tested. */
const FETCH_PATIENCE = {
  // Five minutes by default, which is the whole request. A slow transfer needs
  // longer than a fast one, and waiting is cheaper than starting over.
  npm_config_fetch_timeout: '900000',
  npm_config_fetch_retries: '4',
  npm_config_fetch_retry_maxtimeout: '120000',
  // Progress on a pipe is off, which is why the log went quiet for 105 seconds.
  // This does not turn it on — it says what npm is doing between fetches.
  npm_config_loglevel: 'http',
};

function fetchShape(attempt) {
  return {
    ...FETCH_PATIENCE,
    ...(FETCH_SHAPES[Math.min(attempt - 1, FETCH_SHAPES.length - 1)] ?? {}),
  };
}

/**
 * Run a step, and run it again while its failure looks like the network's.
 *
 * Deliberately narrow. A command that fails on its own terms fails on the first
 * attempt: retrying `npm ci` because a lockfile disagrees would waste two minutes
 * to reach the same conclusion, and retrying anything with side effects would be
 * worse than that.
 *
 * Attempts are not hidden. One step is recorded, because a step is a stage of the
 * pipeline rather than a count of tries, and what the earlier attempts printed is
 * kept in its output — a run that took three goes to install should look like one.
 */
async function runWithRetries(name, command, options = {}) {
  const attempts = options.attempts ?? RETRY_BACKOFF_MS.length + 1;
  const earlier = [];

  // The attempts share the step's budget rather than each taking all of it. A
  // step may run for the whole job by default, so three attempts of that would
  // reach the job's own deadline — and then the run reports "job exceeded
  // 1800000ms" instead of which step could not finish, which is the wrong sentence
  // to be handed. Installs that succeed take one or two minutes; a third of the
  // budget is generous against that and still leaves the agent its time.
  const perAttempt = options.timeoutMs
    ? Math.floor(options.timeoutMs / attempts)
    : undefined;

  for (let attempt = 1; ; attempt += 1) {
    const shape = options.reshapeFetches ? fetchShape(attempt) : {};
    const step = await run(name, command, {
      ...options,
      ...(perAttempt ? { timeoutMs: perAttempt } : {}),
      env: { ...(options.env ?? {}), ...shape },
      record: false,
    });
    const reason = step.success ? null : transientNetworkFailure(step.output);
    const lastAttempt = attempt >= attempts;

    if (step.success || !reason || lastAttempt) {
      if (earlier.length > 0) {
        step.output = truncate(
          `${earlier.join('\n')}\n--- attempt ${attempt} ---\n${step.output}`,
          options.maxOutput ?? MAX_STEP_OUTPUT
        );
      }
      steps.push(step);
      if (!step.success && !options.allowFailure) {
        const gaveUp = reason ? ` after ${attempt} attempts (${reason})` : '';
        throw new Error(`step "${name}" failed with exit code ${step.exitCode}${gaveUp}`);
      }
      return step;
    }

    const wait = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
    const next = options.reshapeFetches
      ? `, with ${fetchShape(attempt + 1).npm_config_maxsockets} parallel fetches instead of ${shape.npm_config_maxsockets}`
      : '';
    log(
      'system',
      `⟳ ${name}: ${reason} — the network, not the job. Retrying in ${wait / 1000}s` +
        ` (attempt ${attempt + 1} of ${attempts})${next}`
    );
    earlier.push(`--- attempt ${attempt} (exit ${step.exitCode}, ${reason}) ---\n${step.output}`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

function skip(name, reason) {
  steps.push({ name, command: '', exitCode: 0, success: true, durationMs: 0, output: reason, skipped: true });
  log('system', `⏭ ${name} — ${reason}`);
}

// ------------------------------------------------------- environment checks

/**
 * Variables that must not be set inside the container, and why their absence is
 * the desired result.
 *
 * Credentials reach this container by being attached outside it — the Worker's
 * outbound handler swaps in the Anthropic credential and attaches GitHub's as
 * Basic auth (ADR 0002) — so anything found here arrived by a route nobody
 * intended.
 *
 * Which Anthropic variables are foreign depends on the credential the deployment
 * holds, and it is the *other* scheme's that must be absent. Under a
 * subscription that is `ANTHROPIC_API_KEY`, which would move the bill to
 * pay-as-you-go; under an API key it is `CLAUDE_CODE_OAUTH_TOKEN`, which would
 * route a paying job through somebody's personal plan. The scheme's own variable
 * is expected to be set — in proxy mode to a sentinel, in direct mode to the real
 * credential — so it is not checked here. This list mirrors
 * `foreignCredentialVariables` in the Worker; the two sides cannot import from
 * one another, and disagreeing means either a job that fails while correctly
 * configured or a check that passes while billing the wrong account.
 *
 * A check is a shell command that exits zero when the environment is as promised
 * and prints a line either way. Written as data so the next invariant is an
 * entry rather than a rewrite; nothing here assumes the check is about variables,
 * only that it reports and exits.
 */
function environmentCheckList(authScheme) {
  const apiKeyScheme = authScheme === 'api-key';
  return [
    apiKeyScheme
      ? absent(
          ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
          'Claude Code will use the API key this deployment is configured with',
          'this environment must use the configured API key only'
        )
      : absent(
          ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
          'Claude Code will use the subscription credential',
          'this environment must use the subscription credential only'
        ),
    absent(
      ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_APP_PRIVATE_KEY'],
      'git reaches GitHub through the Worker, which attaches the credential outside the container',
      'this container must never hold a GitHub credential'
    ),
  ];
}

/** A check that these variables are unset, and says so in both directions. */
function absent(variables, whyGood, whyBad) {
  const names = variables.join(' ');
  return (
    `set=""; for v in ${names}; do [ -n "\${!v}" ] && set="$set $v"; done; ` +
    `if [ -n "$set" ]; then echo "SET in the container:$set — ${whyBad}"; exit 1; fi; ` +
    `echo "checked ${variables.join(', ')}: none is set — ${whyGood}"`
  );
}

/** Every check, in one script, failing if any of them failed. */
function environmentChecks(authScheme) {
  const checks = environmentCheckList(authScheme);
  return `failed=0\n${checks.map((check) => `{ ${check} ; } || failed=1`).join('\n')}\nexit $failed`;
}

/**
 * The credential variables this run must not use, cleared in the shell that runs
 * `claude` — the middle of the three layers described above.
 */
function unsetForeignCredentials(authScheme) {
  return authScheme === 'api-key'
    ? 'unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN;'
    : 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;';
}

// -------------------------------------------------------------- the job

/** Remembered for the failure path, which reports outside main()'s scope. */
let workBranch = null;

async function main() {
  const job = JSON.parse(readFileSync(`${STATE_DIR}/job.json`, 'utf8'));
  workBranch = job.branch ?? null;
  const { commands = {}, options = {} } = job;
  // Defaulted, because a runner shipped with one job and read by another is the
  // drift ADR 0007 is about: an older Worker writes no `authScheme`, and the
  // scheme this executor had until there were two of them is the subscription.
  const authScheme = job.authScheme === 'api-key' ? 'api-key' : 'subscription';

  setStatus('preparing');
  log('system', `job ${job.id}`);
  log('system', `base branch ${job.baseBranch} → work branch ${job.branch}`);
  // Named because it decides which account pays and which model did the work,
  // and neither is recoverable from the diff afterwards. Never a value: the
  // credential is not here to print (ADR 0002).
  log('system', `credential ${authScheme}, model ${job.model ?? 'claude-code default'}`);

  // The repository is cloned by the Worker before this starts: cloning needs
  // credentials injected outside the container, which is exactly what this
  // process must never see.

  // What the container has to be before any work starts.
  //
  // One step, several checks. A step per check would grow the pipeline every time
  // an invariant is added, and what a reader wants is one line saying the
  // environment is as promised — with the detail underneath when they look.
  //
  // Each check says what it examined and which way is good news. The version
  // before this printed "no API-key credential present", which said neither, and
  // was read as a report about the GitHub credential by somebody with every
  // reason to read it that way. A check nobody can interpret will be interpreted
  // wrongly.
  //
  // Names are printed, never values.
  const environment = await run('verify-environment', environmentChecks(authScheme), {
    allowFailure: true,
  });
  if (!environment.success) {
    throw new Error(
      `the container is not the environment this pipeline requires:\n${environment.output.trim()}`
    );
  }

  await run('git-config', `git -C ${REPO_DIR} config user.name ${shellQuote(GIT_USER_NAME)}`);
  await run('git-config-email', `git -C ${REPO_DIR} config user.email ${shellQuote(GIT_USER_EMAIL)}`);
  // `-b` fails when the branch is already there, which is exactly the case on a
  // follow-up turn: the restored workspace is still standing on it.
  await run(
    'git-branch',
    `git -C ${REPO_DIR} checkout ${shellQuote(job.branch)} 2>/dev/null || ` +
      `git -C ${REPO_DIR} checkout -b ${shellQuote(job.branch)}`
  );

  setStatus('installing');
  // Retried, because a reset socket here loses a whole run before the agent has
  // said anything. The checks below are not: they run after the work exists, so
  // their failure costs a report rather than the job.
  if (commands.install) {
    await runWithRetries('install', commands.install, {
      timeoutMs: job.stepTimeoutMs,
      // Fewer parallel fetches each time, because what failed was throughput.
      reshapeFetches: true,
    });
  }
  else skip('install', 'INSTALL_COMMAND is not configured');

  setStatus('running');
  const claude = await run(
    'claude-code',
    [
      unsetForeignCredentials(authScheme),
      'claude -p',
      shellQuote(job.prompt),
      // Absent means Claude Code's own default, which is what a deployment that
      // has not chosen a model wants — the default moves as models are released.
      ...(job.model ? ['--model', shellQuote(job.model)] : []),
      // A follow-up turn carries on the conversation the previous one had, which
      // is the difference between answering a question and being asked it again.
      ...(job.resumeSession ? ['--resume', shellQuote(job.resumeSession)] : []),
      // Streamed rather than buffered. Without this nothing is emitted until
      // the whole step finishes, so a job that is working and a job that is
      // stuck look identical for minutes at a time.
      '--output-format stream-json --verbose',
      '--permission-mode bypassPermissions',
      '--append-system-prompt',
      shellQuote(EXTRA_SYSTEM_PROMPT),
    ].join(' '),
    { timeoutMs: job.claudeTimeoutMs, onLine: emitAgentEvent }
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

  // Push only what was committed, and only when asked. A failed push must not
  // lose the diff — it is still worth applying by hand, which is what the whole
  // loop did before this existed.
  let pushed = false;
  if (changed && options.push) {
    setStatus('pushing');
    const push = await run(
      'git-push',
      `git -C ${REPO_DIR} push --set-upstream origin ${shellQuote(job.branch)}`,
      { timeoutMs: job.stepTimeoutMs, allowFailure: true }
    );
    pushed = push.success;
    if (!pushed) {
      log(
        'system',
        'push failed; the diff is still available. The GitHub App needs Contents: Read and write.'
      );
    }
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
    pushed,
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
  // must be written even on the paths that threw — and with the same shape a
  // success has, because the steps are the reason anyone opens a failed job.
  write('result.json', {
    error: message,
    claudeOutput: '',
    changed: false,
    branch: workBranch,
    pushed: false,
    gitStatus: '',
    diffStat: '',
    diffBytes: 0,
    steps,
  });
  setStatus('failed', { error: message });
  process.exit(1);
});
