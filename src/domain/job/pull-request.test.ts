import { describe, expect, test } from 'vitest';
import { composePullRequest } from './pull-request';
import type { JobResult } from './record';

const job = {
  id: 'msn-1',
  prompt: 'describeUpdate にテストが無い。追加してほしい。\n\n詳しくはこう:\n- あれ\n- これ',
  baseBranch: 'main',
  branch: 'claude/msn-1',
  pullRequest: undefined,
};

function result(overrides: Partial<JobResult> = {}): JobResult {
  return {
    claudeOutput: '',
    changed: true,
    branch: 'claude/msn-1',
    pushed: true,
    gitStatus: '',
    diffStat: ' AGENTS.md | 13 +++++++++++++\n 1 file changed',
    diffBytes: 400,
    steps: [
      { name: 'install', command: 'npm ci', exitCode: 0, success: true, durationMs: 1, output: '' },
      { name: 'test', command: 'npm test', exitCode: 0, success: true, durationMs: 1, output: '' },
      { name: 'build', command: '', exitCode: 0, success: true, durationMs: 0, output: 'BUILD_COMMAND is not configured', skipped: true },
      { name: 'git-push', command: 'git push', exitCode: 0, success: true, durationMs: 1, output: '' },
    ],
    ...overrides,
  };
}

describe('the title', () => {
  test('is the prompt’s first line', () => {
    expect(composePullRequest(job, result()).title).toBe(
      'describeUpdate にテストが無い。追加してほしい。'
    );
  });

  test('is truncated rather than allowed to run on', () => {
    const long = { ...job, prompt: 'あ'.repeat(200) };
    const { title } = composePullRequest(long, result());
    expect(title).toHaveLength(68);
    expect(title.endsWith('…')).toBe(true);
  });

  test('is whatever the caller said, when they said anything', () => {
    const withOverride = { ...job, pullRequest: { title: 'P0-4: wire a Task to a sandbox run' } };
    expect(composePullRequest(withOverride, result()).title).toBe('P0-4: wire a Task to a sandbox run');
  });

  test('a blank override is not an override', () => {
    const blank = { ...job, pullRequest: { title: '   ' } };
    expect(composePullRequest(blank, result()).title).toBe(
      'describeUpdate にテストが無い。追加してほしい。'
    );
  });
});

describe('the body', () => {
  test('carries what was asked, in full', () => {
    expect(composePullRequest(job, result()).body).toContain('- これ');
  });

  test('carries what the executor observed', () => {
    const body = composePullRequest(job, result()).body;
    expect(body).toContain('AGENTS.md | 13');
    expect(body).toContain('✔ test (npm test)');
    expect(body).toContain('⏭ build');
    expect(body).toContain('msn-1');
    expect(body).toContain('`main`');
  });

  // The steps are what ran. The agent's closing message is a summary written by
  // the thing under review, and belongs in `status`, not in the case for merging.
  test('does not quote the agent’s own account of itself', () => {
    const body = composePullRequest(job, result({ claudeOutput: 'I fixed everything perfectly' })).body;
    expect(body).not.toContain('perfectly');
  });

  test('reports a failed check as failed', () => {
    const failing = result({
      steps: [{ name: 'test', command: 'npm test', exitCode: 1, success: false, durationMs: 1, output: '' }],
    });
    expect(composePullRequest(job, failing).body).toContain('✖ test');
  });

  test('survives a job with no result at all', () => {
    expect(composePullRequest(job, undefined).body).toContain('remote-claude job');
  });
});

describe('draft', () => {
  test('is off unless asked for', () => {
    expect(composePullRequest(job, result()).draft).toBe(false);
    expect(composePullRequest({ ...job, pullRequest: { draft: true } }, result()).draft).toBe(true);
  });
});
