import { describe, expect, test } from 'vitest';
import { Job } from './job';
import type { JobResult } from './record';

const BASE = {
  id: 'm8x2k1-ab12cd34',
  prompt: '  make the tests pass  ',
  repo: 'https://github.com/r-hashi01/spindle.git',
  baseBranch: 'main',
  now: 1_000,
};

function result(overrides: Partial<JobResult> = {}): JobResult {
  return {
    claudeOutput: 'x'.repeat(50_000),
    changed: true,
    branch: 'claude/m8x2k1-ab12cd34',
    pushed: false,
    gitStatus: 'M src/index.ts',
    diffStat: '1 file changed',
    diffBytes: 420,
    steps: [
      { name: 'test', command: 'npm test', exitCode: 0, success: true, durationMs: 12, output: 'y'.repeat(60_000) },
    ],
    ...overrides,
  };
}

describe('creating a job', () => {
  test('starts queued, with a branch named after itself', () => {
    const job = Job.create(BASE);
    expect(job.status).toBe('queued');
    expect(job.branch).toBe('claude/m8x2k1-ab12cd34');
    expect(job.toRecord().createdAt).toBe(1_000);
  });

  test('normalises the prompt and the refs it was given', () => {
    const job = Job.create({ ...BASE, baseBranch: ' develop ', branch: ' feature/x ' });
    expect(job.toRecord().prompt).toBe('make the tests pass');
    expect(job.toRecord().baseBranch).toBe('develop');
    expect(job.branch).toBe('feature/x');
  });

  test('refuses input the executor could not run', () => {
    expect(() => Job.create({ ...BASE, prompt: '' })).toThrow(/prompt is required/);
    expect(() => Job.create({ ...BASE, baseBranch: 'no; rm -rf /' })).toThrow(/invalid branch name/);
  });

  test('options default to off', () => {
    expect(Job.create(BASE).toRecord().options).toEqual({
      skipChecks: false,
      keepSandbox: false,
      push: false,
    });
  });
});

describe('the model a job runs', () => {
  test('by default it names none, and runs the deployment’s', () => {
    const job = Job.create(BASE);
    expect(job.model).toBeUndefined();
    expect(job.resolveModel('claude-opus-4-5')).toBe('claude-opus-4-5');
  });

  test('its own choice wins over the deployment’s', () => {
    const job = Job.create({ ...BASE, model: 'haiku' });
    expect(job.model).toBe('haiku');
    expect(job.resolveModel('claude-opus-4-5')).toBe('haiku');
  });

  // Neither side having chosen is a real answer: Claude Code's own default,
  // which moves as models are released.
  test('nothing chosen anywhere leaves the choice to Claude Code', () => {
    expect(Job.create(BASE).resolveModel(undefined)).toBeUndefined();
  });

  test('a blank model is not a choice', () => {
    expect(Job.create({ ...BASE, model: '  ' }).model).toBeUndefined();
    expect(Job.create({ ...BASE, model: '  ' }).toRecord()).not.toHaveProperty('model');
  });

  // Refused where a caller is still waiting, rather than in a container twenty
  // seconds later.
  test('refuses something that is not a model name', () => {
    expect(() => Job.create({ ...BASE, model: 'the fast one' })).toThrow(/not a model name/);
  });
});

describe('the commands a job runs', () => {
  test('by default it brings none of its own', () => {
    expect(Job.create(BASE).commandOverrides).toEqual({});
  });

  test('keeps what it was given', () => {
    const job = Job.create({ ...BASE, commands: { install: 'npm ci', test: 'npm test' } });
    expect(job.commandOverrides).toEqual({ install: 'npm ci', test: 'npm test' });
  });

  // An empty string is a real value: the runner reads it as "skip this step".
  // Dropping it would silently fall back to the deployment's command.
  test('an empty command is kept, because empty means skip', () => {
    expect(Job.create({ ...BASE, commands: { install: '' } }).commandOverrides).toEqual({
      install: '',
    });
  });

  // JSON cannot carry undefined, but a caller assembling the object in code can.
  test('a key with no value is not an override', () => {
    const job = Job.create({ ...BASE, commands: { install: 'npm ci', lint: undefined } });
    expect(job.commandOverrides).toEqual({ install: 'npm ci' });
  });
});

describe('the execution lifecycle', () => {
  test('queued → starting → running', () => {
    const job = Job.create(BASE);
    job.start(2_000);
    expect(job.status).toBe('starting');
    expect(job.toRecord().startedAt).toBe(2_000);
    // A restarted job must not resume mirroring from a stale offset.
    expect(job.toRecord().logSeq).toBe(0);

    job.markRunning();
    expect(job.status).toBe('running');
  });

  test('requeueing forgets that the job ever started', () => {
    const job = Job.create(BASE);
    job.start(2_000);
    job.recordProgress(2_500, 12);

    job.requeue({ attempts: 1 });

    const record = job.toRecord();
    expect(job.status).toBe('queued');
    expect(record.startedAt).toBeUndefined();
    expect(record.logSeq).toBe(0);
    expect(record.attempts).toBe(1);
  });

  test('progress advances the log offset and the progress clock together', () => {
    const job = Job.create(BASE);
    job.start(2_000);
    job.recordProgress(3_000, 40);
    expect(job.toRecord().logSeq).toBe(40);
    expect(job.toRecord().lastProgressAt).toBe(3_000);
  });

  test('settling records the outcome', () => {
    const job = Job.create(BASE);
    job.start(2_000);
    expect(job.settle('completed', 9_000, { result: result() })).toBe(true);
    expect(job.status).toBe('completed');
    expect(job.toRecord().finishedAt).toBe(9_000);
    expect(job.isTerminal).toBe(true);
  });

  // Several paths can reach a settled job at once — a cancellation racing a
  // finished runner, a poll racing the sweep. The first outcome is the true one.
  test('a settled job cannot be settled again', () => {
    const job = Job.create(BASE);
    job.start(2_000);
    job.settle('completed', 9_000, {});

    expect(job.settle('failed', 10_000, { error: 'too late' })).toBe(false);
    expect(job.status).toBe('completed');
    expect(job.toRecord().finishedAt).toBe(9_000);
    expect(job.toRecord().error).toBeUndefined();
  });

  test('usage and the closing message survive a later failure', () => {
    const job = Job.create(BASE);
    job.start(2_000);
    job.recordUsage({ inputTokens: 10, outputTokens: 20, costUsd: null, turns: 2 });
    job.recordFinalText('I changed two files.');
    job.settle('failed', 9_000, { error: 'the runner died' });

    expect(job.toRecord().usage?.outputTokens).toBe(20);
    expect(job.toRecord().finalText).toBe('I changed two files.');
    expect(job.toRecord().error).toBe('the runner died');
  });
});

describe('summarising for a list', () => {
  test('keeps what a list renders and drops what it does not', () => {
    const job = Job.create(BASE);
    job.start(2_000);
    job.settle('completed', 9_000, { result: result() });

    const summary = job.toSummary();
    expect(summary.prompt).toBe('make the tests pass');
    expect(summary.result).toEqual({
      changed: true,
      commitSha: undefined,
      branch: 'claude/m8x2k1-ab12cd34',
      pushed: false,
      diffStat: '1 file changed',
      diffBytes: 420,
    });
    // The bulk — every step's captured output and the raw agent stream — is the
    // whole reason this projection exists.
    expect(JSON.stringify(summary).length).toBeLessThan(2_000);
  });

  test('a job with no result summarises to one without a result', () => {
    expect(Job.create(BASE).toSummary().result).toBeUndefined();
  });
});

describe('round-tripping through storage', () => {
  test('a record restored from storage behaves like the job that wrote it', () => {
    const job = Job.create(BASE);
    job.start(2_000);
    job.recordProgress(3_000, 7);

    const restored = Job.fromRecord(JSON.parse(JSON.stringify(job.toRecord())));

    expect(restored.toRecord()).toEqual(job.toRecord());
    expect(restored.status).toBe('starting');
    expect(restored.isTerminal).toBe(false);
  });
});

describe('continuing a job', () => {
  function finished(overrides: Partial<ReturnType<Job['toRecord']>> = {}): Job {
    const job = Job.create({ ...BASE, options: { push: true } });
    job.start(2_000);
    job.recordClaudeSession('conv-1');
    job.settle('completed', 9_000, { result: result() });
    const record = { ...job.toRecord(), workspace: { provider: 'fake', id: 'snap-1' }, ...overrides };
    return Job.fromRecord(record);
  }

  const input = { id: 'next-1', prompt: 'use the JobClient interface', now: 20_000 };

  test('carries on the same branch, so one diff keeps growing', () => {
    const next = Job.continuing(finished(), input);

    expect(next.branch).toBe('claude/m8x2k1-ab12cd34');
    expect(next.repo).toBe(BASE.repo);
    expect(next.baseBranch).toBe('main');
    expect(next.toRecord().prompt).toBe('use the JobClient interface');
  });

  test('restores the workspace and resumes the conversation', () => {
    const next = Job.continuing(finished(), input);

    expect(next.restoreFrom).toEqual({ provider: 'fake', id: 'snap-1' });
    expect(next.resumeSession).toBe('conv-1');
    expect(next.continues).toBe('m8x2k1-ab12cd34');
  });

  test('inherits the options and commands, and lets this turn override them', () => {
    const previous = Job.fromRecord({
      ...finished().toRecord(),
      commands: { install: 'npm ci', test: 'npm test' },
    });

    const next = Job.continuing(previous, { ...input, commands: { test: 'npm test -- --run' } });

    expect(next.options.push).toBe(true);
    expect(next.commandOverrides).toEqual({ install: 'npm ci', test: 'npm test -- --run' });
  });

  /**
   * A follow-up answers the question the previous turn stopped on, so switching
   * models silently would change who is answering it. Naming one is still
   * allowed: a cheap follow-up on expensive work, or the reverse when the first
   * answer was not good enough, are both reasonable.
   */
  test('keeps the model the previous turn ran, unless this turn names another', () => {
    const previous = Job.fromRecord({ ...finished().toRecord(), model: 'claude-opus-4-5' });

    expect(Job.continuing(previous, input).model).toBe('claude-opus-4-5');
    expect(Job.continuing(previous, { ...input, model: 'haiku' }).model).toBe('haiku');
  });

  test('refuses a job that has not finished', () => {
    const running = Job.create(BASE);
    running.start(2_000);
    running.markRunning();

    expect(() => Job.continuing(running, input)).toThrow(/only be continued once it has finished/);
  });

  // Without it there is nothing to continue from, and a fresh clone would look
  // like continuing while behaving like starting over.
  test('refuses when no workspace was kept', () => {
    expect(() => Job.continuing(finished({ workspace: undefined }), input)).toThrow(
      /kept no workspace/
    );
  });

  // The case that produces this: a job that failed at install, before the agent
  // ever ran. There is a tree, but no conversation and no work in it.
  test('refuses when there is no conversation to resume', () => {
    expect(() => Job.continuing(finished({ claudeSessionId: undefined }), input)).toThrow(
      /never started a conversation/
    );
  });
});
