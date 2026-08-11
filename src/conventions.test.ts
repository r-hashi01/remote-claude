import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

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
