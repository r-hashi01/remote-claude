import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { unsetForeignCredentials } from './domain/agent/command';

/**
 * Checks about the code rather than about its behaviour.
 *
 * Each one exists because the same mistake was made more than once, and each
 * replaces an audit somebody did by hand and would have to remember to repeat.
 * Finding a class of defect and fixing its instances leaves the class in place;
 * this is where a class gets closed.
 *
 * If one of these fails, the fix is usually in the code rather than in the list —
 * and where it is in the list, the list wants a reason next to it.
 */

const sources = globSync('src/**/*.ts', { cwd: process.cwd() }).filter(
  (path) => !path.includes('.test.') && !path.endsWith('testing.ts')
);

const read = (path: string) => readFileSync(path, 'utf8');

/** For checks about what the code does, rather than what it says about itself. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('an error says what kind of answer it is', () => {
  /**
   * Failures where 500 — or a job's own error field — is the honest answer.
   *
   * Two kinds. Some become a job's error rather than a response, and a job that
   * dies mid-flight reports through its record where there is no status to get
   * wrong. The rest are somebody else's outage: nothing the caller sends and
   * nothing this deployment configures would have avoided them.
   *
   * Everything else has to choose: `Refusal` for "not like that" (400) and
   * `NotFound` for "not here" (404).
   */
  const NOT_THE_CALLERS = [
    // Become the job's own error.
    'cloning ${job.repo} at branch',
    'the workspace of the job this continues could not be restored',
    // Reported into the job's log after it has already settled.
    'GitHub refused the pull request',
    'GitHub accepted the pull request but returned no URL',
    // GitHub misbehaving, rather than anything asked of it.
    'could not read ${slug} from GitHub',
    'failed to mint GitHub App installation token',
  ];

  test('every thrown Error is either classified or documented as internal', () => {
    const unclassified: string[] = [];

    for (const path of sources) {
      const source = read(path);
      for (const match of source.matchAll(/throw new Error\(\s*([`'"][^`'"]{0,80})/g)) {
        const message = match[1]!.slice(1);
        if (NOT_THE_CALLERS.some((known) => message.startsWith(known))) continue;
        const line = source.slice(0, match.index).split('\n').length;
        unclassified.push(`${path}:${line}  ${message}`);
      }
    }

    // The list in the failure is the whole point: it says what to decide.
    expect(unclassified, [
      'These throw a plain Error, so the HTTP layer answers 500.',
      'Choose one: Refusal (400) if the caller or the deployment can fix it,',
      'NotFound (404) if this executor simply does not have it, or add it to',
      'NOT_THE_CALLERS above with a reason if 500 is the honest answer.',
      '',
      'This check exists because replacing keyword-matched statuses turned three',
      'caller mistakes into 500s silently, and a fourth was found by hand later.',
    ].join('\n')).toEqual([]);
  });
});

describe('every declared setting is read by somebody', () => {
  /**
   * Read outside this repository, so a grep here finds nothing.
   *
   * The sandbox SDK takes these from the Worker's environment. A sweep for dead
   * configuration flagged two of them as unused and was right to leave them
   * alone for the wrong reason: "nobody reads this" had meant "nobody in this
   * repository reads this", and the range of the grep had become the range of
   * the conclusion. Keeping workspaces needs all four.
   */
  const READ_BY_THE_SANDBOX_SDK = [
    'SANDBOX_TRANSPORT',
    'BACKUP_BUCKET_NAME',
    'CLOUDFLARE_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ];

  test('or is written down as read elsewhere', () => {
    const env = read('src/infrastructure/env.ts');
    const declared = [...env.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\??:/gm)].map((match) => match[1]!);
    expect(declared.length).toBeGreaterThan(10);

    const elsewhere = sources
      .filter((path) => !path.endsWith('infrastructure/env.ts'))
      .map(read)
      .join('\n');

    const unread = declared.filter(
      (name) => !READ_BY_THE_SANDBOX_SDK.includes(name) && !elsewhere.includes(name)
    );

    expect(unread, [
      'These are declared in Env and read nowhere in src.',
      'Either delete them — a setting that changes nothing is worse than absent,',
      'because it reads as if it works — or, if something outside this repository',
      'reads them, add them to READ_BY_THE_SANDBOX_SDK with a note saying so.',
    ].join('\n')).toEqual([]);
  });
});

/**
 * The sandbox may not be allowed to fall asleep during a job.
 *
 * `SANDBOX_SLEEP_AFTER` is an inactivity timer over requests to the container,
 * not over work happening inside it, and a runner started as a background process
 * holds nothing open. At "2m" it slept the container out from under three
 * consecutive jobs, each about two minutes in, mid agent step — and presented as
 * the platform losing containers, which is a considerably harder thing to read
 * than a number being too small.
 *
 * The value was defended in a comment for a reason that was true about sandbox
 * reuse and silent about what the timer measures. A comment cannot notice that;
 * this can.
 */
describe('a sandbox outlasts the job it is holding', () => {
  const durations: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

  function toMs(value: string): number {
    const match = /^(\d+)(s|m|h)$/.exec(value.trim());
    if (!match) throw new Error(`unrecognised duration: ${value}`);
    return Number(match[1]) * (durations[match[2] as string] as number);
  }

  test.each(['wrangler.jsonc', 'src/infrastructure/config.ts'])(
    '%s keeps the sleep timer above the job budget',
    (path) => {
      const source = read(path);
      const sleepAfter = /SANDBOX_SLEEP_AFTER[^\n]*?['"](\d+[smh])['"]/.exec(source);
      // config.ts states the fallback rather than the deployed value; both are a
      // sleep timer a job can outlive, so both are checked the same way.
      const fallback = /sleepAfter:[^\n]*?['"](\d+[smh])['"]/.exec(source);
      const configured = sleepAfter?.[1] ?? fallback?.[1];
      expect(configured, `no sleep timer found in ${path}`).toBeDefined();

      const budget = /JOB_TIMEOUT_MS[^\n]*?['"](\d+)['"]/.exec(read('wrangler.jsonc'));
      expect(budget?.[1], 'no job budget found in wrangler.jsonc').toBeDefined();

      expect(toMs(configured as string)).toBeGreaterThan(Number(budget?.[1]));
    }
  );
});

/**
 * `TERMINAL_STATUSES` is declared twice: once in `src/domain/job/status.ts` for
 * the executor, and again in `sdk/src/domain/job.ts` for the SDK. They cannot
 * import from one another — the SDK has to install outside this repository,
 * without this repository's dependencies — so nothing but this check keeps
 * them in step. A status added to one list and not the other is a job the
 * executor considers finished that an SDK consumer, checking its own copy,
 * would still be waiting on.
 */
describe('the executor and the SDK agree on which statuses are terminal', () => {
  const extractTerminalStatuses = (path: string): string[] => {
    const match = /TERMINAL_STATUSES = \[([^\]]*)\]/.exec(read(path));
    expect(match, `no TERMINAL_STATUSES array found in ${path}`).not.toBeNull();
    return [...match![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!).sort();
  };

  test('src/domain/job/status.ts and sdk/src/domain/job.ts list the same statuses', () => {
    expect(extractTerminalStatuses('src/domain/job/status.ts')).toEqual(
      extractTerminalStatuses('sdk/src/domain/job.ts')
    );
  });
});

/**
 * The classification has to survive the boundary the request crosses.
 *
 * `Refusal` and `NotFound` were checked with `instanceof` only, and every test
 * that exercised them called the service directly. The real request does not:
 * `createJob` runs inside a Durable Object, and RPC rebuilds an error from its
 * name rather than its class. So the rule held everywhere it was tested and
 * nowhere it mattered — every refusal raised inside the object answered 500,
 * which also told every client that a permanent refusal was worth retrying.
 *
 * The name is the contract, so it may not be spelled by hand in the layer that
 * reads it, and it may not be taken from the class identifier a build may rename.
 */
describe('a refusal survives being thrown across a Durable Object', () => {
  test('the HTTP layer classifies by name as well as by class', () => {
    const source = read('src/interface/http/errors.ts');
    expect(source).toMatch(/error instanceof Error \? error\.name/);
    expect(source).toMatch(/=== NOT_FOUND/);
    expect(source).toMatch(/=== REFUSAL/);
  });

  test('the names come from one place, and not from the class identifier', () => {
    expect(read('src/domain/job/errors.ts')).toMatch(/this\.name = (REFUSAL|NOT_FOUND);/);
    for (const path of ['src/domain/job/errors.ts', 'src/interface/http/errors.ts']) {
      // Code only: these files explain the trap in prose, and a check that reads
      // the explanation as an instance of it fails for saying the right thing.
      expect(withoutComments(read(path)), `${path} reads a name a build may rename`).not.toMatch(
        /(Refusal|NotFound)\.name/
      );
    }
  });
});

/**
 * Everything the API accepts has to be reachable from the client shipped with it.
 *
 * Three capabilities existed in the API and the SDK and not in this CLI: naming a
 * repository, continuing a job, and supplying the commands to run. The first was
 * found by a verification job answering about the wrong repository; the third by
 * noticing that two throwaway scripts existed only because the CLI could not do
 * it. None of them were hard — they were invisible, which is why this is a test
 * and not a habit.
 *
 * The awkward part is that the names differ by design: `skipChecks` is
 * `--skip-checks`, `commands` is four separate flags. So the CLI states the
 * mapping and this checks the mapping is total.
 */
describe('the CLI can express every job the API accepts', () => {
  /** Field names of an interface in the SDK's wire types. */
  function fieldsOf(interfaceName: string): string[] {
    const source = read('sdk/src/domain/job.ts');
    const body = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`).exec(source);
    expect(body, `no interface ${interfaceName}`).not.toBeNull();
    return [...withoutComments(body?.[1] ?? '').matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map(
      (match) => match[1] as string
    );
  }

  /** The map the CLI declares from those fields to its own spelling. */
  function mapped(constName: string): string[] {
    const source = read('cli/remote-claude.mjs');
    const body = new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\n\\};`).exec(source);
    expect(body, `no ${constName} in the CLI`).not.toBeNull();
    return [...withoutComments(body?.[1] ?? '').matchAll(/^\s{2}([a-zA-Z]+):/gm)].map(
      (match) => match[1] as string
    );
  }

  test.each([
    ['StartJob', 'RUN_OPTIONS'],
    ['ContinueJob', 'CONTINUE_OPTIONS'],
  ])('%s is covered by %s', (interfaceName, constName) => {
    expect(mapped(constName).sort()).toEqual(fieldsOf(interfaceName).sort());
  });
});

/**
 * A flag the documentation offers has to be one that command accepts.
 *
 * `--pr` was in the usage text, in the README, and in the skill. `cmdRun` read
 * `opts.pr`. It was never in that command's list of flags, so it was rejected as
 * an unknown option — for as long as it had been documented. Opening a pull
 * request is how this executor hands work back, and the way it was advertised was
 * the one way it could not be asked for.
 *
 * Checked per command rather than across the whole CLI. The first version of this
 * check asked only whether some command somewhere accepted the flag, and it did
 * not fail when `--pr` was taken back off `run` — `continue` still had it. A
 * guard that does not fail on the defect it was written for is worse than none.
 *
 * Quoted strings are stripped first: a documented example passes commands to the
 * job (`--install "npm ci --no-audit"`), and npm's flags are not this CLI's.
 */
describe('the documentation only offers flags the command has', () => {
  const cli = read('cli/remote-claude.mjs');

  /** command word → the name of the function that handles it. */
  const handlers = new Map(
    [...(/const COMMANDS = \{([\s\S]*?)\n\};/.exec(cli)?.[1] ?? '').matchAll(
      /(\w+): (cmd\w+)/g
    )].map((match) => [match[1] as string, match[2] as string])
  );

  /** Everything that function will accept, however it reads it. */
  function accepts(functionName: string): Set<string> {
    const from = cli.indexOf(`async function ${functionName}(`);
    expect(from, `no ${functionName}`).toBeGreaterThan(-1);
    const next = cli.indexOf('\nasync function ', from + 1);
    const body = cli.slice(from, next === -1 ? undefined : next);
    return new Set([
      // Declared for the argument parser…
      ...[...body.matchAll(/(?:flags|values): \[([^\]]*)\]/g)]
        .flatMap((match) => [...(match[1] as string).matchAll(/'([a-z-]+)'/g)])
        .map((match) => match[1] as string),
      // …or read straight off argv by a command with no options of its own.
      ...[...body.matchAll(/includes\('--([a-z][a-z-]+)'\)/g)].map((match) => match[1] as string),
    ]);
  }

  test.each(['README.md', 'docs/usage.md', '.claude/skills/delegate/SKILL.md'])('%s', (path) => {
    const unaccepted: string[] = [];

    for (const line of read(path).split('\n')) {
      const invocation = /remote-claude(?:\.mjs)?\s+(\S*)/.exec(line);
      if (!invocation) continue;
      // A bare prompt is shorthand for `run`, exactly as the CLI treats it.
      const command = handlers.has(invocation[1] as string) ? (invocation[1] as string) : 'run';
      const handler = handlers.get(command);
      if (!handler) continue;

      const unquoted = line.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
      for (const match of unquoted.matchAll(/(?<!\w)--([a-z][a-z-]+)/g)) {
        const flag = match[1] as string;
        // Handled before the parser sees anything.
        if (flag === 'help') continue;
        if (!accepts(handler).has(flag)) unaccepted.push(`${command} --${flag}`);
      }
    }

    expect(unaccepted).toEqual([]);
  });

  /**
   * The options table in the usage document is the reference somebody reads
   * before writing a command, so it is checked as well — command lines are where
   * copy-paste happens, and this is where belief is formed. Prose elsewhere is not
   * checked: a flag named in a sentence cannot be told apart from npm's.
   */
  test('the options table in docs/usage.md', () => {
    const rows = [...read('docs/usage.md').matchAll(/^\| `\w+` \| ([^|]+)\|/gm)];
    expect(rows.length, 'no options table found').toBeGreaterThan(5);

    const offered = rows
      .flatMap((row) => [...(row[1] as string).matchAll(/`--([a-z][a-z-]+)`/g)])
      .map((match) => match[1] as string);
    expect(offered.length, 'a table with no flags in it').toBeGreaterThan(5);

    const run = accepts(handlers.get('run') as string);
    expect(offered.filter((flag) => !run.has(flag))).toEqual([]);
  });
});

/**
 * A setting that is read and then never consulted does nothing, quietly.
 *
 * `ALLOW_PUSH` was parsed into the policy and asked about nowhere, so a
 * deployment that forbade pushing handed out pushes — and the guard above, which
 * only asks whether an environment variable is *read*, was satisfied the whole
 * time. Being read is one step; being consulted is the step that has an effect.
 *
 * Every field is consulted today. This exists because the one that was not took a
 * live incident to notice.
 */
describe('every policy field is consulted by somebody', () => {
  const consumers = globSync('src/**/*.ts', { cwd: process.cwd() }).filter(
    (path) =>
      !path.includes('.test.') &&
      !path.endsWith('testing.ts') &&
      // Where the policy is built and declared, rather than acted on.
      !path.endsWith('infrastructure/config.ts') &&
      !path.endsWith('application/ports/index.ts')
  );

  test('nothing in ExecutorPolicy is decoration', () => {
    const policy = /export interface ExecutorPolicy \{([\s\S]*?)\n\}/.exec(
      read('src/application/ports/index.ts')
    );
    expect(policy, 'no ExecutorPolicy').not.toBeNull();

    const fields = [
      ...withoutComments(policy?.[1] ?? '').matchAll(/^\s{2}([a-zA-Z]+)\??:/gm),
    ].map((match) => match[1] as string);
    expect(fields.length, 'no fields found').toBeGreaterThan(5);

    const sources = consumers.map(read).join('\n');
    expect(fields.filter((field) => !sources.includes(`policy.${field}`))).toEqual([]);
  });
});

/**
 * The runner's input is a file, and files have no types.
 *
 * `job.json` is the whole contract between the Worker and the process that does
 * the work, and the two sides are a TypeScript module and a plain-JS file that
 * never import from one another. A field the runner reads and nobody writes is
 * `undefined` at the point it matters — for a timeout, that means no timeout,
 * which looks like nothing at all until a step hangs for the length of the job.
 */
describe('the runner and the Worker agree on job.json', () => {
  test('every field the runner reads is one the Worker writes', () => {
    const runner = read('container/runner.mjs');
    const written = read('src/application/job-service.ts');

    const read_ = [...withoutComments(runner).matchAll(/\bjob\.([a-zA-Z]+)/g)]
      .map((match) => match[1] as string)
      // The state file's own name, not a field of the job.
      .filter((field) => field !== 'json');
    expect(read_.length, 'the runner reads nothing?').toBeGreaterThan(4);

    // The Worker writes the file as one object literal; a key there is the field.
    const payload = /`\$\{STATE_DIR\}\/job\.json`,\s*JSON\.stringify\(\{([\s\S]*?)\n *\}\)/.exec(
      written
    );
    expect(payload, 'no job.json payload found').not.toBeNull();
    const keys = new Set(
      [...withoutComments(payload?.[1] ?? '').matchAll(/^\s+([a-zA-Z]+)[:,]/gm)].map(
        (match) => match[1] as string
      )
    );

    expect([...new Set(read_)].filter((field) => !keys.has(field))).toEqual([]);
  });
});

/**
 * The executor is the deployer's own tool, and nothing a caller sends can change
 * whose it is.
 *
 * Where the credential is kept is a question this deployment may yet answer
 * differently — today it is a Worker secret. Where it may *not* come from is
 * settled: a request. No field on anything a caller sends may carry one, because
 * the moment one does, a deployment stops being a person running Claude Code on
 * a machine they rented and becomes a service holding other people's
 * credentials — the arrangement Claude Code's terms name and refuse ("route
 * requests through Free, Pro, or Max plan credentials on behalf of their users",
 * https://code.claude.com/docs/en/legal-and-compliance).
 *
 * That property is currently true because nobody has added the field. This makes
 * it true because adding it fails. The idea that arrives as "it would be
 * convenient to accept a per-user token" is a reasonable-sounding one, which is
 * why it wants a test in its way rather than a paragraph somewhere.
 */
describe('nothing a caller sends can carry a credential', () => {
  // Both halves. The SDK re-declares these shapes rather than importing them, and
  // `sdk-contract.ts` does not close this: `Extends<sdk.StartJob, JobRequest>`
  // stays true when the SDK grows a field the API lacks, because a type with
  // extra properties still extends one without them. Checked by adding
  // `oauthToken` to `sdk.StartJob` — typecheck passed.
  //
  // What did fail was `the CLI can express every job the API accepts`, saying the
  // CLI had no flag for it. Following that failure where it points adds a
  // `--oauth-token` flag, which is the opposite of the fix. So the guard has to
  // reach the SDK itself and say why.
  const requestTypes = [
    ['src/domain/job/record.ts', 'JobRequest'],
    ['src/application/job-service.ts', 'ContinueRequest'],
    ['src/domain/job/pull-request.ts', 'PullRequestRequest'],
    ['sdk/src/domain/job.ts', 'StartJob'],
    ['sdk/src/domain/job.ts', 'ContinueJob'],
  ] as const;

  // Names a credential would plausibly arrive under. Not an exhaustive list of
  // secrets — an exhaustive list of what somebody would call one in a hurry.
  const credentialish = /token|credential|secret|password|apikey|api_key|oauth|bearer|auth/i;

  test.each(requestTypes)('%s: %s has no credential-shaped field', (path, name) => {
    const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(read(path));
    expect(body, `no ${name} in ${path}`).not.toBeNull();

    const fields = [
      ...withoutComments(body?.[1] ?? '').matchAll(/^\s{2}([a-zA-Z_]+)\??:/gm),
    ].map((match) => match[1] as string);
    expect(fields.length, `no fields found on ${name}`).toBeGreaterThan(0);

    expect(fields.filter((field) => credentialish.test(field))).toEqual([]);
  });

  test('the layer that reads requests never names the credential', () => {
    // `src/interface/**` is where a caller's bytes become a call. Naming the
    // credential there is how a request would come to influence which one is
    // used — so nothing there may.
    //
    // Not `src/domain/**`: `domain/agent/environment.ts` names the variable
    // because deciding what reaches the container is a rule, and it is the rule
    // ADR 0002 is about. It chooses between a placeholder and a value handed to
    // it; it has no way to obtain one.
    //
    // Not `src/infrastructure/**`: reading it from `Env` is the intended path,
    // and the only one.
    // Both credentials, because there are two schemes now and the argument is
    // the same for each: a request that could name `ANTHROPIC_API_KEY` is a
    // request that could bring its own.
    const offenders = sources
      .filter((path) => path.startsWith('src/interface/'))
      .filter((path) =>
        /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/.test(withoutComments(read(path)))
      );

    expect(offenders).toEqual([]);
  });
});

/**
 * One rule, two copies, and no import between them.
 *
 * Which credential variables `claude` must not find set depends on the scheme,
 * and it is written twice: in `domain/agent/command.ts` for the Worker's own
 * invocations, and in `container/runner.mjs` for the job pipeline. The runner is
 * plain JS shipped into a container and cannot import from `src`.
 *
 * Both directions of disagreement are bad and neither is loud. A runner that
 * unsets `ANTHROPIC_API_KEY` under the API-key scheme clears the credential the
 * job was configured to use, and `claude` fails on a correctly configured
 * deployment. A runner that leaves the subscription token set under the API-key
 * scheme bills the wrong account and works.
 */
describe('the runner and the Worker clear the same credentials', () => {
  test('every scheme’s unset line appears verbatim in the runner', () => {
    const runner = read('container/runner.mjs');
    for (const scheme of ['subscription', 'api-key'] as const) {
      expect(runner, `the runner does not clear what ${scheme} must clear`).toContain(
        unsetForeignCredentials(scheme)
      );
    }
  });
});
