import { beforeEach, describe, expect, test } from 'vitest';
import { REPO_DIR, STATE_DIR, WORKSPACE_DIR, JobService, type JobServiceDeps } from './job-service';
import { Job } from '../domain/job/job';
import type { ExecutorPolicy } from './ports';
import {
  AllowAllGitHub,
  DenyAllGitHub,
  ReadOnlyGitHub,
  FakeClock,
  FakeIds,
  FakeSandboxProvider,
  InMemoryArtifactStore,
  InMemoryJobStore,
  InMemoryLedgerStore,
  InMemoryLogStore,
  InMemoryPackageCacheStore,
  InMemoryRunningJobs,
  RecordingScheduler,
} from './testing';

const CONFIGURED_REPO = 'https://github.com/r-hashi01/spindle.git';

function policy(overrides: Partial<ExecutorPolicy> = {}): ExecutorPolicy {
  return {
    repoUrl: CONFIGURED_REPO,
    defaultBaseBranch: 'main',
    allowCustomRepo: true,
    allowPush: false,
    maxConcurrency: 2,
    jobTimeoutMs: 30 * 60 * 1000,
    claudeTimeoutMs: 25 * 60 * 1000,
    heartbeatTimeoutMs: 90_000,
    stallTimeoutMs: 8 * 60 * 1000,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    sleepAfter: '2m',
    cloneDepth: 1,
    commands: { install: '', lint: '', test: '', build: '' },
    claudeAuthScheme: 'subscription',
    ...overrides,
  };
}

interface Harness {
  service: JobService;
  deps: JobServiceDeps;
  clock: FakeClock;
  jobs: InMemoryJobStore;
  logs: InMemoryLogStore;
  artifacts: InMemoryArtifactStore;
  ledger: InMemoryLedgerStore;
  sandboxes: FakeSandboxProvider;
  scheduler: RecordingScheduler;
  running: InMemoryRunningJobs;
}

function harness(overrides: Partial<JobServiceDeps> = {}): Harness {
  const clock = new FakeClock();
  const jobs = new InMemoryJobStore();
  const logs = new InMemoryLogStore();
  const artifacts = new InMemoryArtifactStore();
  const ledger = new InMemoryLedgerStore();
  const sandboxes = new FakeSandboxProvider();
  const scheduler = new RecordingScheduler();
  const running = new InMemoryRunningJobs();

  const deps: JobServiceDeps = {
    policy: policy(),
    clock,
    ids: new FakeIds(),
    jobs,
    logs,
    artifacts,
    ledger,
    sandboxes,
    github: new AllowAllGitHub(),
    scheduler,
    running,
    redact: (input) => input.replaceAll('hunter2', '[redacted]'),
    runnerSource: '// runner',
    ...overrides,
  };

  return { service: new JobService(deps), deps, clock, jobs, logs, artifacts, ledger, sandboxes, scheduler, running };
}

/** The runner's own log format: one NDJSON line per sequence number. */
function ndjson(...lines: Array<{ seq: number; stream: string; line: string }>): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

describe('accepting a job', () => {
  test('queues it against the configured repository and wakes the executor', async () => {
    const { service, jobs, scheduler } = harness();

    const job = await service.createJob({ prompt: 'fix the build' });

    expect(job.status).toBe('queued');
    expect(job.repo).toBe(CONFIGURED_REPO);
    expect(job.baseBranch).toBe('main');
    expect(jobs.load(job.id)?.status).toBe('queued');
    // Returned before anything is cloned; the alarm picks the work up.
    expect(scheduler.delays).toEqual([0]);
  });

  test('refuses a repository this deployment is not configured for, and says whose configuration that is', async () => {
    const { service } = harness({ policy: policy({ allowCustomRepo: false }) });

    await expect(
      service.createJob({ prompt: 'x', repo: 'https://github.com/other/thing.git' })
    ).rejects.toThrow(/pinned to .*spindle.* will not run against .*other\/thing.*disabled on the executor/s);
  });

  test('asks GitHub whether the credential reaches a custom repository, before starting anything', async () => {
    const github = new AllowAllGitHub();
    const { service } = harness({ github });

    await service.createJob({ prompt: 'x', repo: 'https://github.com/other/thing.git' });

    expect(github.checked).toEqual(['https://github.com/other/thing.git']);
  });

  test('a repository the installation cannot reach is refused at this call', async () => {
    const { service, jobs } = harness({ github: new DenyAllGitHub('installation cannot reach other/thing') });

    await expect(
      service.createJob({ prompt: 'x', repo: 'https://github.com/other/thing.git' })
    ).rejects.toThrow(/cannot reach other\/thing/);
    // Nothing was queued, so nothing will fail later on clone.
    expect(jobs.listRecent(10)).toHaveLength(0);
  });

  test('the configured repository in another form is not a custom repository', async () => {
    const github = new AllowAllGitHub();
    const { service } = harness({ policy: policy({ allowCustomRepo: false }), github });

    const job = await service.createJob({ prompt: 'x', repo: 'https://github.com/r-hashi01/spindle' });

    expect(job.repo).toBe(CONFIGURED_REPO);
    expect(github.checked).toEqual([]);
  });

  // ALLOW_PUSH was read into config and then never consulted: a job asking to
  // push got one, on a deployment configured to forbid it.
  test('refuses a push when the executor forbids pushing', async () => {
    const { service } = harness({ policy: policy({ allowPush: false }) });

    await expect(service.createJob({ prompt: 'x', push: true })).rejects.toThrow(
      /pushing is disabled on it.*ALLOW_PUSH=true/s
    );
  });

  // The runner never pushed at all: `pushed: false` was hard-coded in the
  // result while the option was accepted and gated. So "may this job push" now
  // has two answers to satisfy — the deployment's switch, and the credential.
  test('asks GitHub whether the credential can write before accepting a push', async () => {
    const github = new AllowAllGitHub();
    const { service } = harness({ policy: policy({ allowPush: true }), github });

    await service.createJob({ prompt: 'x', push: true });

    expect(github.checkedForWriting).toEqual([CONFIGURED_REPO]);
  });

  test('refuses a push the credential cannot deliver', async () => {
    const { service, jobs } = harness({ policy: policy({ allowPush: true }), github: new ReadOnlyGitHub() });

    await expect(service.createJob({ prompt: 'x', push: true })).rejects.toThrow(
      /Contents: Read and write/
    );
    // Refused at the door: no job to produce a branch it could not deliver.
    expect(jobs.listRecent(10)).toHaveLength(0);
  });

  test('a job that does not push is never asked about writing', async () => {
    const github = new AllowAllGitHub();
    const { service } = harness({ policy: policy({ allowPush: true }), github });

    await service.createJob({ prompt: 'x' });

    expect(github.checkedForWriting).toEqual([]);
  });

  test('passes the push through when the executor allows it', async () => {
    const { service, sandboxes } = harness({ policy: policy({ allowPush: true }) });

    const job = await service.createJob({ prompt: 'x', push: true });
    await service.tick();

    expect(job.options.push).toBe(true);
    const written = sandboxes.get(`rc-${job.id}`).files.get(`${STATE_DIR}/job.json`) as string;
    expect(JSON.parse(written).options.push).toBe(true);
  });

  test('a job that never asked to push is unaffected by the switch', async () => {
    const { service } = harness({ policy: policy({ allowPush: false }) });
    expect((await service.createJob({ prompt: 'x' })).options.push).toBe(false);
  });

  test('forgets jobs past the retention window', async () => {
    const { service, jobs, clock, deps } = harness();
    const old = await service.createJob({ prompt: 'ancient' });

    clock.advance(deps.policy.retentionMs + 1);
    const fresh = await service.createJob({ prompt: 'current' });

    expect(jobs.load(old.id)).toBeNull();
    expect(jobs.load(fresh.id)).not.toBeNull();
  });
});

describe('starting queued work', () => {
  test('clones, ships the runner and starts it', async () => {
    const { service, sandboxes, jobs } = harness();
    const job = await service.createJob({ prompt: 'fix the build' });

    await service.tick();

    const sandbox = sandboxes.get(`rc-${job.id}`);
    // Shallow: the platform's checkout fetches objects one at a time, and that is
    // where every interruption has landed.
    expect(sandbox.cloned).toEqual({ repo: CONFIGURED_REPO, branch: 'main', depth: 1 });
    expect(sandbox.files.get(`${STATE_DIR}/runner.mjs`)).toBe('// runner');
    expect(JSON.parse(sandbox.files.get(`${STATE_DIR}/job.json`) as string)).toMatchObject({
      id: job.id,
      prompt: 'fix the build',
      branch: job.branch,
    });
    // Started as a process the platform owns and can be asked about, rather than
    // backgrounded from a shell whose session may or may not outlive the call.
    expect(sandbox.commands.join('\n')).toMatch(/node .*runner\.mjs/);
    expect([...sandbox.processes.keys()]).toEqual([`runner-${job.id}`]);
    expect(jobs.load(job.id)?.status).toBe('running');
  });

  // The commands belonged to the deployment while the repository did too. Since
  // a job may name its own repository (ADR 0010), running the deployment's
  // install against it fails — and `skipChecks` does not cover install, so there
  // was no way to run a job on any other repository at all.
  test('a job can bring its own commands, and inherits the rest', async () => {
    const { service, sandboxes } = harness({
      policy: policy({
        commands: { install: 'their-install', lint: 'their-lint', test: 'their-test', build: '' },
      }),
    });

    const job = await service.createJob({
      prompt: 'x',
      commands: { install: 'npm ci --no-audit --no-fund', test: 'npm test' },
    });
    await service.tick();

    const written = JSON.parse(
      sandboxes.get(`rc-${job.id}`).files.get(`${STATE_DIR}/job.json`) as string
    );
    expect(written.commands).toEqual({
      install: 'npm ci --no-audit --no-fund',
      lint: 'their-lint',
      test: 'npm test',
      build: '',
    });
  });

  test('a job that brings none runs the deployment’s commands unchanged', async () => {
    const commands = { install: 'their-install', lint: '', test: '', build: '' };
    const { service, sandboxes } = harness({ policy: policy({ commands }) });

    const job = await service.createJob({ prompt: 'x' });
    await service.tick();

    const written = JSON.parse(
      sandboxes.get(`rc-${job.id}`).files.get(`${STATE_DIR}/job.json`) as string
    );
    expect(written.commands).toEqual(commands);
  });

  /**
   * The runner has no other source for either of these. The scheme decides which
   * credential variables it clears and checks — getting it wrong fails a
   * correctly configured job, or bills an account nobody chose — and the model
   * decides what did the work.
   */
  test('tells the runner which credential and which model', async () => {
    const { service, sandboxes } = harness({
      policy: policy({ claudeAuthScheme: 'api-key', model: 'claude-opus-4-5' }),
    });

    const job = await service.createJob({ prompt: 'x' });
    await service.tick();

    const written = JSON.parse(
      sandboxes.get(`rc-${job.id}`).files.get(`${STATE_DIR}/job.json`) as string
    );
    expect(written.authScheme).toBe('api-key');
    expect(written.model).toBe('claude-opus-4-5');
  });

  test('a job’s own model wins over the deployment’s', async () => {
    const { service, sandboxes } = harness({ policy: policy({ model: 'claude-opus-4-5' }) });

    const job = await service.createJob({ prompt: 'x', model: 'haiku' });
    await service.tick();

    const written = JSON.parse(
      sandboxes.get(`rc-${job.id}`).files.get(`${STATE_DIR}/job.json`) as string
    );
    expect(written.model).toBe('haiku');
  });

  // Absent rather than a name written down here: the runner passes no `--model`,
  // and Claude Code's own default applies.
  test('no model anywhere leaves the field out', async () => {
    const { service, sandboxes } = harness();

    const job = await service.createJob({ prompt: 'x' });
    await service.tick();

    const written = JSON.parse(
      sandboxes.get(`rc-${job.id}`).files.get(`${STATE_DIR}/job.json`) as string
    );
    expect(written.model).toBeUndefined();
  });

  test('starts no more at once than the deployment allows', async () => {
    const { service, jobs } = harness({ policy: policy({ maxConcurrency: 1 }) });
    const first = await service.createJob({ prompt: 'one' });
    const second = await service.createJob({ prompt: 'two' });

    await service.tick();

    expect(jobs.load(first.id)?.status).toBe('running');
    expect(jobs.load(second.id)?.status).toBe('queued');
  });

  // Nothing has executed yet in this window, so a retry has no side effects.
  test('requeues when the platform was merely busy', async () => {
    const { service, jobs, sandboxes } = harness();
    const job = await service.createJob({ prompt: 'x' });
    sandboxes.createError = 'Error updating the sandbox runtime';

    await service.tick();

    const requeued = jobs.load(job.id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.attempts).toBe(1);
    expect(requeued?.startedAt).toBeUndefined();
  });

  test('fails a job whose repository or branch does not resolve, naming both', async () => {
    const { service, jobs, sandboxes } = harness();
    const job = await service.createJob({ prompt: 'x', baseBranch: 'nope' });
    sandboxes.get(`rc-${job.id}`).cloneError = 'fatal: Remote branch nope not found';

    await service.tick();

    const failed = jobs.load(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/branch "nope"/);
    expect(failed?.error).toMatch(/GitHub App installation/);
  });
});

describe('following a running job', () => {
  async function started(): Promise<Harness & { jobId: string }> {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    return { ...h, jobId: job.id };
  }

  test('mirrors the runner output and counts it as progress', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    sandbox.files.set(
      `${STATE_DIR}/log.ndjson`,
      ndjson(
        { seq: 1, stream: 'stdout', line: 'npm install' },
        { seq: 2, stream: 'stdout', line: 'added 42 packages' }
      )
    );
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'install', updatedAt: h.clock.now() }));

    h.clock.advance(2_000);
    await h.service.tick();

    expect(h.logs.all(h.jobId)).toContain('added 42 packages');
    const job = h.jobs.load(h.jobId);
    expect(job?.logSeq).toBe(2);
    expect(job?.lastProgressAt).toBe(h.clock.now());
  });

  test('reads the agent event stream through the translator rather than dumping it', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    const event = {
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'Looking at the failing test' }] },
    };
    sandbox.files.set(
      `${STATE_DIR}/log.ndjson`,
      ndjson({ seq: 1, stream: 'agent', line: JSON.stringify(event) })
    );
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'agent', updatedAt: h.clock.now() }));

    await h.service.tick();

    expect(h.logs.all(h.jobId).join('\n')).toContain('Looking at the failing test');
  });

  test('records what the agent consumed as it arrives, so a later failure keeps it', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    const result = {
      type: 'result',
      subtype: 'success',
      result: 'Fixed it.',
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    sandbox.files.set(
      `${STATE_DIR}/log.ndjson`,
      ndjson({ seq: 1, stream: 'agent', line: JSON.stringify(result) })
    );
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'agent', updatedAt: h.clock.now() }));

    await h.service.tick();

    const job = h.jobs.load(h.jobId)?.toRecord();
    expect(job?.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(job?.finalText).toBe('Fixed it.');
  });

  // It arrives in the first event of every run. Continuing a job later is only
  // possible because of it, and it used to be read and dropped.
  test('remembers the conversation the agent is having', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    sandbox.files.set(
      `${STATE_DIR}/log.ndjson`,
      ndjson({
        seq: 1,
        stream: 'agent',
        line: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }),
      })
    );
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'agent', updatedAt: h.clock.now() }));

    await h.service.tick();

    expect(h.jobs.load(h.jobId)?.claudeSessionId).toBe('abc-123');
  });

  test('settles a finished job, storing the patch and the result', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() }));
    sandbox.files.set(`${STATE_DIR}/patch.diff`, 'diff --git a b\n+token hunter2\n');
    sandbox.files.set(
      `${STATE_DIR}/result.json`,
      JSON.stringify({
        claudeOutput: '',
        changed: true,
        branch: 'claude/x',
        pushed: false,
        gitStatus: '',
        diffStat: '1 file changed',
        diffBytes: 40,
        steps: [],
      })
    );

    await h.service.tick();

    const job = h.jobs.load(h.jobId);
    expect(job?.status).toBe('completed');
    expect(job?.toRecord().result?.diffStat).toBe('1 file changed');
    // Value-based redaction happens on this side: the container never held the
    // secrets, so it could not have masked them itself.
    expect(await h.artifacts.getPatch(h.jobId)).toContain('[redacted]');
    expect(sandbox.destroyed).toBe(true);
  });

  // The runner sends its steps even when it fails; the executor used to keep only
  // the error line, so the one case that needs diagnosis had the least of it.
  test('a failed job keeps the steps that ran', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'failed', updatedAt: h.clock.now() }));
    sandbox.files.set(
      `${STATE_DIR}/result.json`,
      JSON.stringify({
        error: 'step "install" failed with exit code 1',
        claudeOutput: '',
        changed: false,
        branch: 'claude/x',
        pushed: false,
        gitStatus: '',
        diffStat: '',
        diffBytes: 0,
        steps: [
          { name: 'verify-environment', command: 'checks …', exitCode: 0, success: true, durationMs: 12, output: '' },
          { name: 'install', command: 'npm --prefix packages/spindle-core ci', exitCode: 1, success: false, durationMs: 874, output: 'npm error code EUSAGE' },
        ],
      })
    );

    await h.service.tick();

    const job = h.jobs.load(h.jobId)?.toRecord();
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/step "install" failed/);
    // Which command ran, and what it printed — the reason to look at a failure.
    expect(job?.result?.steps.map((step) => step.name)).toEqual(['verify-environment', 'install']);
    expect(job?.result?.steps[1]?.command).toMatch(/npm --prefix/);
    expect(job?.result?.steps[1]?.output).toMatch(/EUSAGE/);
    // The reason lives on the record. Leaving a copy inside `result` would put
    // the same fact in two places, one of which no type describes.
    expect(job?.result).not.toHaveProperty('error');
  });

  test('a job asked to keep its sandbox keeps it', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x', keepSandbox: true });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() }));

    await h.service.tick();

    expect(h.jobs.load(job.id)?.status).toBe('completed');
    expect(sandbox.destroyed).toBe(false);
  });

  test('presumes a runner that stopped beating is dead, and reports what it printed', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'agent', updatedAt: h.clock.now() }));
    sandbox.setProcess(`runner-${h.jobId}`, { alive: false, output: 'Error: out of memory' });

    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    const job = h.jobs.load(h.jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/stopped responding during "agent"/);
    expect(job?.error).toMatch(/out of memory/);
    expect(sandbox.killed).toBe(true);
  });

  // Twice in five launches the runner started, wrote no status and printed
  // nothing. Both absent means nothing ran, so this is the pre-runner window.
  test('requeues a runner that started and reported nothing at all', async () => {
    const h = await started();

    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    const job = h.jobs.load(h.jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    expect(h.logs.all(h.jobId).join('\n')).toMatch(/reported nothing/);
    expect(h.sandboxes.get(`rc-${h.jobId}`).destroyed).toBe(true);
  });

  // A real job: install ran for 24 seconds, the agent step started, and then the
  // container went away twelve seconds after a deploy — every call into it failed
  // with a platform interruption and the runner process was no longer held. The
  // container takes the whole workspace with it, so there is nothing half-done to
  // protect and a fresh attempt is the only thing that helps.
  test('requeues a job whose container the platform took away mid-run', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    sandbox.files.set(
      `${STATE_DIR}/log.ndjson`,
      `${JSON.stringify({ seq: 1, ts: h.clock.now(), stream: 'system', line: '✔ install' })}\n`
    );
    await h.service.tick();
    expect(h.jobs.load(h.jobId)?.logSeq).toBe(1);

    // From here the container is unreachable and the platform holds no process.
    sandbox.processes.delete(`runner-${h.jobId}`);
    sandbox.execError =
      'Sandbox operation commands.execute was interrupted while the runtime connection was closing';
    sandbox.files.delete(`${STATE_DIR}/status.json`);
    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    const job = h.jobs.load(h.jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    expect(h.logs.all(h.jobId).join('\n')).toMatch(/took the container away/i);
  });

  // The status file is unreadable in exactly the case where knowing where the job
  // died matters most, and falling back to "startup" then reports the one place
  // it certainly was not. The last phase actually seen is remembered for this.
  test('names the phase it last saw rather than presuming startup', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    sandbox.files.set(
      `${STATE_DIR}/status.json`,
      JSON.stringify({ phase: 'checking', updatedAt: h.clock.now() })
    );
    await h.service.tick();

    sandbox.files.delete(`${STATE_DIR}/status.json`);
    sandbox.setProcess(`runner-${h.jobId}`, { alive: true, output: '' });
    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    const job = h.jobs.load(h.jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/during "checking"/);
    expect(job?.error).not.toMatch(/startup/);
  });

  // The failure that leaves nothing to catch: the instance behind the sandbox is
  // gone, so the next call gets a fresh empty one. Every operation succeeds and
  // the only trace is that what the executor wrote is no longer there.
  test('requeues a job whose container was replaced under it, error or no error', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    sandbox.files.set(
      `${STATE_DIR}/log.ndjson`,
      ndjson({ seq: 1, stream: 'system', line: '✔ install' })
    );
    await h.service.tick();

    // A new, empty instance: nothing throws, and nothing the executor put there
    // survived — including the runner it installed.
    sandbox.files.clear();
    sandbox.processes.delete(`runner-${h.jobId}`);
    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    const job = h.jobs.load(h.jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
  });

  // A killed process and a replaced container look identical from the outside —
  // both leave a runner the platform has no record of — and they want opposite
  // responses. What separates them is whether the container's filesystem is
  // still there, so the failure says which one it found.
  test('says whether the status file went stale or went away', async () => {
    const stale = await started();
    const staleSandbox = stale.sandboxes.get(`rc-${stale.jobId}`);
    staleSandbox.files.set(
      `${STATE_DIR}/status.json`,
      JSON.stringify({ phase: 'running', updatedAt: stale.clock.now() })
    );
    await stale.service.tick();
    staleSandbox.processes.delete(`runner-${stale.jobId}`);
    stale.clock.advance(stale.deps.policy.heartbeatTimeoutMs + 1_000);
    await stale.service.tick();

    expect(stale.jobs.load(stale.jobId)?.error).toMatch(/status file .*stale/i);

    const gone = await started();
    const goneSandbox = gone.sandboxes.get(`rc-${gone.jobId}`);
    goneSandbox.files.set(
      `${STATE_DIR}/status.json`,
      JSON.stringify({ phase: 'running', updatedAt: gone.clock.now() })
    );
    await gone.service.tick();
    goneSandbox.processes.delete(`runner-${gone.jobId}`);
    goneSandbox.files.delete(`${STATE_DIR}/status.json`);
    gone.clock.advance(gone.deps.policy.heartbeatTimeoutMs + 1_000);
    await gone.service.tick();

    expect(gone.jobs.load(gone.jobId)?.error).toMatch(/status file .*gone/i);
  });

  // The reason a runner is killed for its memory is legible only from before it
  // died, so the last reading it managed to write travels with the failure.
  test('reports the memory the runner last recorded', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    sandbox.files.set(
      `${STATE_DIR}/status.json`,
      JSON.stringify({
        phase: 'running',
        updatedAt: h.clock.now(),
        memory: { usedMb: 980, limitMb: 1024 },
      })
    );
    await h.service.tick();
    sandbox.processes.delete(`runner-${h.jobId}`);
    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    expect(h.jobs.load(h.jobId)?.error).toMatch(/980MB of 1024MB/);
  });

  // "It never started" was printed for a job that had run a 24 second install.
  // A claim contradicted by the log above it costs the reader the time it takes
  // to work out which half to believe.
  test('does not claim a runner never started when it had already produced output', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);
    sandbox.files.set(
      `${STATE_DIR}/log.ndjson`,
      `${JSON.stringify({ seq: 1, ts: h.clock.now(), stream: 'system', line: '✔ install' })}\n`
    );
    await h.service.tick();

    // Gone from the platform, but nothing says the platform was at fault — so
    // this is a failure, and the wording is all that is under test.
    sandbox.processes.delete(`runner-${h.jobId}`);
    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    const job = h.jobs.load(h.jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).not.toMatch(/never started/);
    expect(job?.error).toMatch(/no longer holding/);
  });

  test('a runner that printed something is failed, not retried', async () => {
    const h = await started();
    // One line of output means something may have run, so this is not the
    // pre-runner window any more. Asked of the platform now, not read out of a
    // file the runner may never have opened.
    h.sandboxes
      .get(`rc-${h.jobId}`)
      .setProcess(`runner-${h.jobId}`, { alive: false, output: 'Error: out of memory' });

    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    expect(h.jobs.load(h.jobId)?.status).toBe('failed');
  });

  test('stops requeueing once the attempts are spent, and says what the platform still knows', async () => {
    const h = await started();
    const record = h.jobs.load(h.jobId)!;
    record.requeue({ attempts: 2 });
    record.start(h.clock.now());
    record.markRunning();
    h.jobs.save(record);
    // The platform is still holding it, and it has said nothing.
    h.sandboxes.get(`rc-${h.jobId}`).setProcess(`runner-${h.jobId}`, { alive: true });

    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    const job = h.jobs.load(h.jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/still there and has printed nothing/);
  });

  test('says so when the platform never had the process at all', async () => {
    const h = await started();
    const record = h.jobs.load(h.jobId)!;
    record.requeue({ attempts: 2 });
    record.start(h.clock.now());
    record.markRunning();
    h.jobs.save(record);
    h.sandboxes.get(`rc-${h.jobId}`).processes.delete(`runner-${h.jobId}`);

    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    expect(h.jobs.load(h.jobId)?.error).toMatch(/no record of the runner process/i);
  });

  test('presumes a runner that beats but produces nothing is stuck', async () => {
    const h = await started();
    const sandbox = h.sandboxes.get(`rc-${h.jobId}`);

    h.clock.advance(h.deps.policy.stallTimeoutMs + 60_000);
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'test', updatedAt: h.clock.now() }));

    await h.service.tick();

    const job = h.jobs.load(h.jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/presumed stuck/);
  });

  test('stops a job that has outrun its total budget', async () => {
    const h = await started();
    h.clock.advance(h.deps.policy.jobTimeoutMs + 1);

    await h.service.tick();

    expect(h.jobs.load(h.jobId)?.error).toMatch(/exceeded/);
  });
});

describe('opening a pull request', () => {
  /** A finished job whose runner pushed the branch. */
  async function pushedAndFinished(overrides: Parameters<typeof harness>[0] = {}) {
    const h = harness({ policy: policy({ allowPush: true }), ...overrides });
    const job = await h.service.createJob({
      prompt: 'fix the build\n\nand explain why',
      pullRequest: { title: 'P0-4: fix the build' },
    });
    await h.service.tick();

    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() }));
    sandbox.files.set(
      `${STATE_DIR}/result.json`,
      JSON.stringify({
        claudeOutput: '',
        changed: true,
        branch: job.branch,
        pushed: true,
        gitStatus: '',
        diffStat: ' AGENTS.md | 13 +++++',
        diffBytes: 40,
        steps: [{ name: 'test', command: 'npm test', exitCode: 0, success: true, durationMs: 1, output: '' }],
      })
    );
    await h.service.tick();
    return { ...h, jobId: job.id };
  }

  test('asking for one implies a push', async () => {
    const github = new AllowAllGitHub();
    const { service } = harness({ policy: policy({ allowPush: true }), github });

    const job = await service.createJob({ prompt: 'x', pullRequest: {} });

    expect(job.options.push).toBe(true);
    expect(github.checkedForWriting).toEqual([CONFIGURED_REPO]);
    expect(github.checkedForPullRequests).toEqual([CONFIGURED_REPO]);
  });

  test('is refused when the deployment forbids pushing', async () => {
    const { service } = harness({ policy: policy({ allowPush: false }) });

    await expect(service.createJob({ prompt: 'x', pullRequest: {} })).rejects.toThrow(
      /pushing is disabled/
    );
  });

  test('is refused when the credential cannot open one', async () => {
    const { service } = harness({ policy: policy({ allowPush: true }), github: new ReadOnlyGitHub() });

    await expect(service.createJob({ prompt: 'x', pullRequest: {} })).rejects.toThrow(/cannot/);
  });

  test('opens it once the work is pushed, and records where it is', async () => {
    const github = new AllowAllGitHub();
    const h = await pushedAndFinished({ github });

    expect(github.opened).toHaveLength(1);
    expect(github.opened[0]).toMatchObject({
      repo: CONFIGURED_REPO,
      base: 'main',
      title: 'P0-4: fix the build',
      draft: false,
    });
    // The body is composed from what the executor observed, not from the agent.
    expect(github.opened[0]?.body).toContain('AGENTS.md | 13');

    const job = h.jobs.load(h.jobId)?.toRecord();
    expect(job?.pullRequestUrl).toBe('https://github.com/o/r/pull/1');
    expect(h.logs.all(h.jobId).join('\n')).toMatch(/pull request opened/);
  });

  test('a job that pushed nothing gets no pull request', async () => {
    const github = new AllowAllGitHub();
    const h = harness({ policy: policy({ allowPush: true }), github });
    const job = await h.service.createJob({ prompt: 'x', pullRequest: {} });
    await h.service.tick();

    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() }));
    sandbox.files.set(
      `${STATE_DIR}/result.json`,
      JSON.stringify({ claudeOutput: '', changed: false, branch: job.branch, pushed: false, gitStatus: '', diffStat: '', diffBytes: 0, steps: [] })
    );
    await h.service.tick();

    expect(github.opened).toEqual([]);
    expect(h.logs.all(job.id).join('\n')).toMatch(/nothing was pushed/);
  });

  // The work exists on a branch either way; failing the job over the paperwork
  // would throw away a result that is already there.
  test('a pull request that cannot be opened does not fail the job', async () => {
    const github = new AllowAllGitHub();
    github.openError = 'GitHub refused the pull request (422): No commits between main and claude/x';
    const h = await pushedAndFinished({ github });

    expect(h.jobs.load(h.jobId)?.status).toBe('completed');
    const logs = h.logs.all(h.jobId).join('\n');
    expect(logs).toMatch(/could not be opened/);
    expect(logs).toMatch(/is pushed; open it by hand/);
  });

  test('a job that did not ask for one gets none', async () => {
    const github = new AllowAllGitHub();
    const h = harness({ policy: policy({ allowPush: true }), github });
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() }));
    await h.service.tick();

    expect(github.opened).toEqual([]);
  });
});

describe('continuing a job', () => {
  /** A finished job with a workspace and a conversation to carry on. */
  async function finished(h = harness()) {
    const job = await h.service.createJob({ prompt: 'wire the Task to a sandbox run' });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(
      `${STATE_DIR}/log.ndjson`,
      ndjson({
        seq: 1,
        stream: 'agent',
        line: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'conv-1' }),
      })
    );
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() }));
    await h.service.tick();
    return { h, previousId: job.id, branch: job.branch };
  }

  test('queues a turn that restores the workspace and resumes the conversation', async () => {
    const { h, previousId, branch } = await finished();

    const next = await h.service.continueJob(previousId, { prompt: 'use the interface' });

    expect(next.branch).toBe(branch);
    expect(next.continues).toBe(previousId);
    expect(next.restoreFrom).toEqual({ provider: 'fake', id: 'snap-1' });
    expect(next.resumeSession).toBe('conv-1');
    expect(next.status).toBe('queued');
  });

  test('the runner is told which conversation to resume', async () => {
    const { h, previousId } = await finished();

    const next = await h.service.continueJob(previousId, { prompt: 'use the interface' });
    await h.service.tick();

    const written = JSON.parse(
      h.sandboxes.get(`rc-${next.id}`).files.get(`${STATE_DIR}/job.json`) as string
    );
    expect(written.resumeSession).toBe('conv-1');
  });

  test('a first turn is told nothing about resuming', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();

    const written = JSON.parse(
      h.sandboxes.get(`rc-${job.id}`).files.get(`${STATE_DIR}/job.json`) as string
    );
    expect(written.resumeSession).toBeUndefined();
  });

  // Not a refusal: "no such job" is a different answer from "bad request", and
  // the HTTP layer turns this one into a 404 to match every other endpoint.
  test('an unknown job is not found rather than refused', async () => {
    const { service } = harness();
    await expect(service.continueJob('nope', { prompt: 'x' })).rejects.toMatchObject({
      name: 'NotFound',
      message: expect.stringContaining('not one this executor knows'),
    });
  });

  test('refuses to continue a job that is still running', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();

    await expect(h.service.continueJob(job.id, { prompt: 'x' })).rejects.toThrow(
      /only be continued once it has finished/
    );
  });

  test('refuses when the deployment kept no workspace', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.snapshotRef = null;
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() }));
    await h.service.tick();

    await expect(h.service.continueJob(job.id, { prompt: 'x' })).rejects.toThrow(/kept no workspace/);
  });
});

describe('carrying a workspace between sandboxes', () => {
  // A job that stops to ask a question is continued, not restarted (ADR 0011),
  // and continuing needs the tree and the conversation that produced it.
  test('keeps the workspace when the job settles, before the sandbox goes', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() }));

    await h.service.tick();

    expect(sandbox.snapshotted).toHaveLength(1);
    // Excluded by name, not by git: git rules apply only inside a repository and
    // /workspace is one above it, so asking for gitignore there does nothing.
    expect(sandbox.snapshotted[0]).toMatchObject({
      dir: '/workspace',
      // node_modules is reinstalled from the lockfile, and the package cache is
      // stored separately. The job's own state files need no exclusion: they are
      // not in this directory at all (see STATE_DIR).
      excludes: ['node_modules', '.npm-cache'],
    });
    // node_modules is reinstallable; the conversation is not.
    expect(h.jobs.load(job.id)?.toRecord().workspace).toEqual({ provider: 'fake', id: 'snap-1' });
    expect(sandbox.destroyed).toBe(true);
  });

  // It used to be swallowed as "a snapshot is an optimisation". Continuing a job
  // depends on it now, so the reason has to reach somebody.
  test('says why a workspace could not be kept', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.snapshotError = 'R2_ACCESS_KEY_ID is not configured';
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() }));

    await h.service.tick();

    expect(h.jobs.load(job.id)?.status).toBe('completed');
    expect(h.logs.all(job.id).join('\n')).toMatch(/could not be kept: R2_ACCESS_KEY_ID/);
  });

  test('a failed job keeps its workspace too — that is the one worth continuing', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'failed', updatedAt: h.clock.now() }));

    await h.service.tick();

    expect(h.jobs.load(job.id)?.status).toBe('failed');
    expect(h.jobs.load(job.id)?.toRecord().workspace).toBeTruthy();
  });

  // No bucket bound is a deployment's choice, and it already shows as the
  // absence of a workspace on the record.
  test('a deployment with nowhere to keep it simply keeps nothing', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.snapshotRef = null;
    sandbox.files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() }));

    await h.service.tick();

    expect(h.jobs.load(job.id)?.status).toBe('completed');
    expect(h.jobs.load(job.id)?.toRecord().workspace).toBeUndefined();
  });

  test('a job that continues another restores instead of cloning', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'and now the other option' });
    // What `POST /jobs/:id/continue` will set.
    const record = h.jobs.load(job.id)!;
    record.requeue();
    const raw = record.toRecord();
    h.jobs.save(Job.fromRecord({ ...raw, restoreFrom: { provider: 'fake', id: 'snap-1' } }));

    await h.service.tick();

    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    expect(sandbox.restored).toEqual([{ provider: 'fake', id: 'snap-1' }]);
    expect(sandbox.cloned).toBeNull();
    expect(h.logs.all(job.id).join('\n')).toMatch(/restoring the workspace/);
  });

  // Continuing from a fresh clone would look like continuing and behave like
  // starting over, which is the one outcome nobody could detect from the result.
  test('a workspace that cannot be restored fails the job rather than starting over', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    const record = h.jobs.load(job.id)!;
    record.requeue();
    h.jobs.save(Job.fromRecord({ ...record.toRecord(), restoreFrom: { provider: 'fake', id: 'gone' } }));
    h.sandboxes.get(`rc-${job.id}`).restoreSucceeds = false;

    await h.service.tick();

    const failed = h.jobs.load(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/nothing to continue/);
    expect(h.sandboxes.get(`rc-${job.id}`).cloned).toBeNull();
  });
});

describe('cancelling', () => {
  test('a queued job is cancelled without ever starting', async () => {
    const { service, jobs } = harness();
    const job = await service.createJob({ prompt: 'x' });

    await service.cancelJob(job.id);

    expect(jobs.load(job.id)?.status).toBe('cancelled');
  });

  test('a running job is signalled, and settles on the next poll', async () => {
    const { service, jobs, sandboxes } = harness();
    const job = await service.createJob({ prompt: 'x' });
    await service.tick();

    await service.cancelJob(job.id);
    expect(jobs.load(job.id)?.status).toBe('running');

    await service.tick();

    expect(jobs.load(job.id)?.status).toBe('cancelled');
    expect(sandboxes.get(`rc-${job.id}`).killed).toBe(true);
  });

  test('cancelling a finished job changes nothing', async () => {
    const { service, jobs } = harness();
    const job = await service.createJob({ prompt: 'x' });
    await service.cancelJob(job.id);

    await service.cancelJob(job.id);

    expect(jobs.load(job.id)?.finishedAt).toBe(jobs.load(job.id)?.finishedAt);
    expect(jobs.load(job.id)?.status).toBe('cancelled');
  });
});

describe('adopting work after a restart', () => {
  // Since the pipeline moved into the container, an eviction here no longer
  // kills the work — failing those jobs was throwing away work still in flight.
  test('a job whose runner is still alive is resumed', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    h.sandboxes
      .get(`rc-${job.id}`)
      .files.set(`${STATE_DIR}/status.json`, JSON.stringify({ phase: 'agent', updatedAt: h.clock.now() }));

    const restarted = new JobService({ ...h.deps, running: new InMemoryRunningJobs() });
    restarted.adopt();
    await restarted.tick();

    expect(h.jobs.load(job.id)?.status).toBe('running');
  });

  test('a job killed before its runner ever started goes back to the queue', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    // No status.json: the runner never wrote one.

    const restarted = new JobService({ ...h.deps, running: new InMemoryRunningJobs() });
    restarted.adopt();
    await restarted.tick();

    const record = h.jobs.load(job.id);
    expect(record?.status).toBe('queued');
    expect(h.logs.all(job.id).join('\n')).toMatch(/before the runner started/);
  });
});

describe('reclaiming sandboxes', () => {
  test('destroys a sandbox left behind by a job that is over', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();

    // Simulate an eviction: the job settled, but teardown never ran.
    const record = h.jobs.load(job.id)!;
    record.settle('failed', h.clock.now(), { error: 'evicted' });
    h.jobs.save(record);
    h.running.end(job.id);

    await h.service.tick();

    expect(h.sandboxes.get(`rc-${job.id}`).destroyed).toBe(true);
    expect(h.service.listSandboxes().outstanding).toHaveLength(0);
  });
});

describe('reading back', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test('lists newest first, without each step’s captured output', async () => {
    const first = await h.service.createJob({ prompt: 'one' });
    h.clock.advance(10);
    const second = await h.service.createJob({ prompt: 'two' });

    const summaries = h.service.listJobSummaries(10);

    expect(summaries.map((job) => job.id)).toEqual([second.id, first.id]);
    expect(summaries[0]).not.toHaveProperty('result.steps');
  });

  test('serves logs from a sequence number', async () => {
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();

    const all = h.service.getLogs(job.id, 0, 100);
    expect(all.length).toBeGreaterThan(0);
    expect(h.service.getLogs(job.id, all[all.length - 1]!.seq, 100)).toEqual([]);
  });
});

describe('the repository directory contract', () => {
  test('is where the runner expects to find the checkout', () => {
    expect(REPO_DIR).toBe('/workspace/repo');
    expect(STATE_DIR).toBe('/var/lib/remote-claude');
  });
});

/**
 * A job is not finished until what it leaves behind has been taken out.
 *
 * The status was saved as terminal and the workspace stored after it, so a client
 * that waits for the job to finish and then answers it — the sequence a person
 * actually follows — found nothing to continue. Live, one second apart:
 *
 *   $ remote-claude continue mspsy0ei-65df31ae "そのうち最初の1つについて…"
 *   POST /jobs/…/continue failed (400): job … kept no workspace, so there is
 *   nothing to continue.
 *
 * The record had a workspace by the time anybody looked. The upload takes seconds,
 * so this is not a narrow race; it is the normal outcome of replying promptly.
 */
describe('finishing a job', () => {
  test('does not report it done before its workspace is stored', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(
      `${STATE_DIR}/status.json`,
      JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() })
    );

    const seenWhileStoring: (string | undefined)[] = [];
    sandbox.onSnapshot = () => seenWhileStoring.push(h.jobs.load(job.id)?.status);

    await h.service.tick();

    // Whatever a client could observe at that moment, it was not "you may
    // continue this now" while there was nothing yet to continue from.
    expect(seenWhileStoring).toEqual(['running']);
    const settled = h.jobs.load(job.id);
    expect(settled?.status).toBe('completed');
    expect(settled?.toRecord().workspace).toEqual({ provider: 'fake', id: 'snap-1' });
  });
});

/**
 * The pull request has to exist by the time the job says it is finished.
 *
 * Same shape as the workspace: it was opened after the terminal status was saved,
 * so a client that waits for the job to finish and prints its summary saw no
 * pull request and told the reader to apply the diff by hand. The comment on that
 * line calls it "the one line that lets somebody without this CLI see the work" —
 * and it was missing exactly when there was work to see. Job msr38l4i opened
 * pull request #43 and reported `apply locally:` instead.
 *
 * Opening it before settling does not weaken the rule that a pull request must
 * never fail a finished job. That rule is about failure, not about order.
 */
describe('a job that asked for a pull request', () => {
  test('has one by the time it reports finished', async () => {
    const github = new AllowAllGitHub();
    const h = harness({ policy: policy({ allowPush: true }), github });
    const job = await h.service.createJob({ prompt: 'x', push: true, pullRequest: {} });
    await h.service.tick();

    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(
      `${STATE_DIR}/status.json`,
      JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() })
    );
    sandbox.files.set(
      `${STATE_DIR}/result.json`,
      JSON.stringify({
        changed: true,
        pushed: true,
        branch: job.branch,
        claudeOutput: '',
        gitStatus: '',
        diffStat: ' a | 1 +',
        diffBytes: 10,
        steps: [],
      })
    );

    const seenWhileOpening: (string | undefined)[] = [];
    github.onOpen = () => seenWhileOpening.push(h.jobs.load(job.id)?.status);

    await h.service.tick();

    expect(seenWhileOpening).toEqual(['running']);
    const settled = h.jobs.load(job.id);
    expect(settled?.status).toBe('completed');
    expect(settled?.toRecord().pullRequestUrl).toBe('https://github.com/o/r/pull/1');
  });
});

/**
 * Whatever a finished job promises, it has already by the time it says so.
 *
 * Two defects of one shape were found a day apart, both by a person doing the
 * obvious thing immediately after a job finished. The workspace was stored after
 * the terminal status, so answering a job that had just finished was refused for
 * having nothing to continue. The pull request was opened after it, so a job that
 * had opened one reported "apply locally" instead of its URL.
 *
 * Fixing them one at a time leaves the shape in place: anything added to the end
 * of a job later will land after the status again, and the test for it will pass
 * because the test will look afterwards. So this states the invariant instead —
 * observed at the instant the record first says the job is over, which is the
 * instant a client can act on it.
 */
describe('the moment a job reports itself finished', () => {
  test('everything a client can then ask for already exists', async () => {
    const github = new AllowAllGitHub();
    const h = harness({ policy: policy({ allowPush: true }), github });
    const job = await h.service.createJob({ prompt: 'x', push: true, pullRequest: {} });
    await h.service.tick();

    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(
      `${STATE_DIR}/status.json`,
      JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() })
    );
    sandbox.files.set(`${STATE_DIR}/patch.diff`, 'diff --git a/a b/a\n');
    sandbox.files.set(
      `${STATE_DIR}/result.json`,
      JSON.stringify({
        changed: true,
        pushed: true,
        commitSha: 'abcdef1234',
        branch: job.branch,
        claudeOutput: '',
        gitStatus: '',
        diffStat: ' a | 1 +',
        diffBytes: 19,
        steps: [{ name: 'install', command: 'npm ci', exitCode: 0, success: true, durationMs: 1, output: '' }],
      })
    );

    // The first write that says the job is over, and what was true of the world
    // at that write.
    let atTheMoment: { record: ReturnType<Job['toRecord']>; patchStored: boolean } | null = null;
    h.jobs.onSave = (saved) => {
      if (atTheMoment || !saved.isTerminal) return;
      atTheMoment = { record: saved.toRecord(), patchStored: h.artifacts.patches.has(job.id) };
    };

    await h.service.tick();

    expect(atTheMoment).not.toBeNull();
    const { record, patchStored } = atTheMoment!;
    // What the API offers about a finished job, each one asked for by something:
    expect(record.status).toBe('completed');
    expect(record.result?.steps?.length, 'the steps it ran').toBeGreaterThan(0);
    expect(record.workspace, 'so it can be continued').toBeDefined();
    expect(record.pullRequestUrl, 'so the work can be seen without this CLI').toBeDefined();
    expect(patchStored, 'so the diff can be fetched').toBe(true);
  });
});

/**
 * Following the output of a run that is still going.
 *
 * The parsed log answers "where is it up to". This answers "what is happening" —
 * the bytes as the commands produced them, which is where every run that went
 * wrong turned out to be legible: twenty minutes of a loop, an ECONNRESET at
 * install, four minutes of quiet that could have been either.
 */
describe('reading a job\'s terminal output', () => {
  /** A job whose runner is up, which is when there is output to follow. */
  async function running(): Promise<Harness & { jobId: string }> {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    return { ...h, jobId: job.id };
  }

  async function withOutput(body: string): Promise<Harness & { jobId: string }> {
    const h = await running();
    h.sandboxes.get(`rc-${h.jobId}`).files.set(`${STATE_DIR}/output.raw`, body);
    return h;
  }

  test('reads from an offset and says where to continue', async () => {
    const h = await withOutput('▶ install\nadded 101 packages\n');

    const window = await h.service.readOutput(h.jobId, 0, 1_000);

    // Withheld against a secret straddling the end, because more may arrive.
    expect(window.text).toBe('');
    expect(window.nextOffset).toBe(0);
    // In bytes, which is what an offset into the file counts. `▶` is three of
    // them and one character, and conflating the two duplicated output live.
    expect(window.size).toBe(new TextEncoder().encode('▶ install\nadded 101 packages\n').length);
    expect(window.done).toBe(false);
  });

  test('releases everything once the job can produce no more', async () => {
    const h = await withOutput('▶ install\nadded 101 packages\n');
    const job = h.jobs.load(h.jobId)!;
    job.settle('completed', h.clock.now());
    h.jobs.save(job);

    const window = await h.service.readOutput(h.jobId, 0, 1_000);

    expect(window.text).toBe('▶ install\nadded 101 packages\n');
    expect(window.done).toBe(true);
  });

  test('masks a secret the executor holds', async () => {
    const h = await withOutput('token=hunter2 and more\n'.padEnd(600, '.'));
    const job = h.jobs.load(h.jobId)!;
    job.settle('completed', h.clock.now());
    h.jobs.save(job);

    const window = await h.service.readOutput(h.jobId, 0, 1_000);

    expect(window.text).toContain('token=[redacted]');
    expect(window.text).not.toContain('hunter2');
  });

  test('is empty, not an error, before the runner has written anything', async () => {
    const h = await running();

    const window = await h.service.readOutput(h.jobId, 0, 1_000);

    expect(window).toMatchObject({ text: '', nextOffset: 0, size: 0, done: false });
  });

  test('has nothing to say about a job it does not know', async () => {
    const h = harness();
    await expect(h.service.readOutput('no-such-job', 0, 100)).rejects.toThrow(/no-such-job/);
  });
});

/**
 * Not downloading what was already downloaded.
 *
 * One job's install fetched 137 packages, median 1980ms each, one of them taking
 * 27.6 seconds — the path to the registry is slow, so the answer is to stop
 * asking. npm's cache is content-addressed, so a cache from before a dependency
 * moved still answers for everything that did not.
 */
describe('the package cache', () => {
  function harnessWithCache(): Harness & { caches: InMemoryPackageCacheStore } {
    const caches = new InMemoryPackageCacheStore();
    return { ...harness({ caches }), caches };
  }

  /** A job that has finished, having installed and fetched. */
  async function finished(
    h: Harness,
    installOutput = 'npm http fetch GET 200 https://registry.npmjs.org/x (cache miss)'
  ): Promise<string> {
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(
      `${STATE_DIR}/status.json`,
      JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() })
    );
    sandbox.files.set(
      `${STATE_DIR}/result.json`,
      JSON.stringify({
        changed: false,
        pushed: false,
        branch: job.branch,
        claudeOutput: '',
        gitStatus: '',
        diffStat: '',
        diffBytes: 0,
        steps: [
          {
            name: 'install',
            command: 'npm ci',
            exitCode: 0,
            success: true,
            durationMs: 44_632,
            output: installOutput,
          },
        ],
      })
    );
    await h.service.tick();
    return job.id;
  }

  test('is kept when the install went to the network', async () => {
    const h = harnessWithCache();

    const jobId = await finished(h);

    expect(h.jobs.load(jobId)?.status).toBe('completed');
    expect(h.caches.refs.size).toBe(1);
    expect(h.sandboxes.get(`rc-${jobId}`).snapshotted.map((one) => one.dir)).toContain(
      '/workspace/.npm-cache'
    );
  });

  // Uploading costs time as well. Replacing the stored copy with an identical one
  // spends a transfer to arrive where it started.
  test('is left alone when nothing was fetched', async () => {
    const h = harnessWithCache();

    await finished(h, 'up to date, audited 101 packages');

    expect(h.caches.refs.size).toBe(0);
  });

  test('is restored before the runner starts', async () => {
    const h = harnessWithCache();
    h.caches.save('npm-r-hashi01-spindle', { provider: 'fake', id: 'cache-1', dir: '/workspace/.npm-cache' }, 1);

    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();

    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    expect(sandbox.restored.map((one) => one.id)).toEqual(['cache-1']);
    // Before the runner: install is the first thing that would go to the network.
    expect(h.logs.all(job.id).join('\n')).toMatch(/restored the package cache/);
  });

  test('is not carried inside the workspace as well', async () => {
    const h = harnessWithCache();

    const jobId = await finished(h);

    const workspace = h.sandboxes
      .get(`rc-${jobId}`)
      .snapshotted.find((one) => one.dir === '/workspace');
    expect(workspace?.excludes).toContain('.npm-cache');
  });

  // A deployment without a store works; its jobs download what they need.
  test('is simply absent when the deployment keeps none', async () => {
    const h = harness();

    const jobId = await finished(h);

    expect(h.jobs.load(jobId)?.status).toBe('completed');
    expect(h.sandboxes.get(`rc-${jobId}`).snapshotted.map((one) => one.dir)).not.toContain(
      '/workspace/.npm-cache'
    );
  });
});

/**
 * A cache too large for the upload path is not attempted.
 *
 * 193 MB was measured, and that becomes a multipart upload, which fails from inside
 * the container. Two hundred megabytes spent at the end of every job to reach the
 * same error is worse than saying so.
 */
describe('a package cache that cannot be stored', () => {
  test('is measured, reported and left where it is', async () => {
    const caches = new InMemoryPackageCacheStore();
    const h = harness({ caches });
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();

    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.script({ result: { success: true, exitCode: 0, stdout: '193\n', stderr: '' } });
    sandbox.files.set(
      `${STATE_DIR}/status.json`,
      JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() })
    );
    sandbox.files.set(
      `${STATE_DIR}/result.json`,
      JSON.stringify({
        changed: false,
        pushed: false,
        branch: job.branch,
        claudeOutput: '',
        gitStatus: '',
        diffStat: '',
        diffBytes: 0,
        steps: [
          {
            name: 'install',
            command: 'npm ci',
            exitCode: 0,
            success: true,
            durationMs: 1,
            output: 'npm http fetch GET 200 https://registry.npmjs.org/x (cache miss)',
          },
        ],
      })
    );

    await h.service.tick();

    expect(caches.refs.size).toBe(0);
    expect(h.sandboxes.get(`rc-${job.id}`).snapshotted.map((one) => one.dir)).not.toContain(
      '/workspace/.npm-cache'
    );
    expect(h.logs.all(job.id).join('\n')).toMatch(/193MB, over the 100MB/);
  });
});

/**
 * A continuation starts its own record, not the previous turn's.
 *
 * Measured on a real pair: the second turn's log opened with nineteen lines of the
 * first turn's, `job <first-id>` among them, because the workspace it restored
 * carried the state directory and the mirror reads that file from the top.
 *
 * The status file was the sharper end. A restored `status.json` saying `completed`,
 * next to the previous turn's `result.json`, is enough for the first poll of a
 * continuation to finish it with an answer from before it started — avoided only by
 * the runner rewriting the status about a second before that poll looked.
 *
 * The fix is not an exclusion. The state directory is not in the workspace, so there
 * is nothing to exclude and nothing to remember.
 */
describe('what a stored workspace leaves behind', () => {
  test('cannot include the job state, because it is not in the workspace', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    await h.service.tick();
    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    sandbox.files.set(
      `${STATE_DIR}/status.json`,
      JSON.stringify({ phase: 'completed', updatedAt: h.clock.now() })
    );

    await h.service.tick();

    // Nothing to exclude: the conveyor is not inside the thing being carried.
    expect(STATE_DIR.startsWith(WORKSPACE_DIR)).toBe(false);

    const workspace = sandbox.snapshotted.find((one) => one.dir === WORKSPACE_DIR);
    expect(workspace?.excludes).toEqual(['node_modules', '.npm-cache']);
  });
});

/**
 * What the platform said, on the record.
 *
 * A container start failed and cost a day to investigate: the record said an
 * operation had been interrupted and stopped there, where the platform had already
 * said which failure it was. It says `reason`, `phase`, whether a retry is safe, and
 * whether the work landed — and none of it was being kept.
 */
describe('a failure the platform explained', () => {
  /**
   * An error shaped as the SDK shapes them — thrown as it is, not converted.
   *
   * The point of the change under test: whatever the platform put in `context`
   * reaches the log and the record, including fields nothing here knows about.
   */
  function interrupted(reason: string, context: Record<string, unknown> = {}): Error {
    const error = new Error('Sandbox operation process.start was interrupted');
    return Object.assign(error, {
      toJSON: () => ({
        name: 'OperationInterruptedError',
        message: error.message,
        code: 'OPERATION_INTERRUPTED',
        operation: 'process.start',
        httpStatus: 503,
        context: {
          reason,
          retryable: reason === 'runtime_replaced',
          phase: 'awaiting-response',
          admitted: false,
          ...context,
        },
        timestamp: '2026-08-18T00:00:00.000Z',
        stack: 'Error: …',
      }),
    });
  }

  test('is written to the log and kept on the job', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    // Fail the start three times over, so the attempt budget runs out and the job
    // settles rather than being requeued.
    h.sandboxes.get(`rc-${job.id}`).startProcessErrorObject = interrupted('recovery_exhausted');

    for (let attempt = 0; attempt < 4; attempt += 1) await h.service.tick();

    const settled = h.jobs.load(job.id);
    expect(settled?.status).toBe('failed');
    // The platform's own words, not a sentence written here about them.
    expect(settled?.toRecord().error).toMatch(/code=OPERATION_INTERRUPTED/);
    expect(settled?.toRecord().error).toMatch(/"reason":"recovery_exhausted"/);
    expect(settled?.toRecord().error).toMatch(/"phase":"awaiting-response"/);
    expect(h.logs.all(job.id).join('\n')).toMatch(/platform error: code=OPERATION_INTERRUPTED/);
  });

  // The distinction message matching could not make. Both read almost the same.
  test('is retried when the platform says the runtime was replaced', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    h.sandboxes.get(`rc-${job.id}`).startProcessErrorObject = interrupted('runtime_replaced');

    await h.service.tick();

    expect(h.jobs.load(job.id)?.status).toBe('queued');
    expect(h.jobs.load(job.id)?.attempts).toBe(1);
  });

  test('is not retried when the platform says the sandbox is gone', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    h.sandboxes.get(`rc-${job.id}`).startProcessErrorObject = interrupted('sandbox_lifetime_changed');

    await h.service.tick();

    expect(h.jobs.load(job.id)?.status).toBe('failed');
    expect(h.jobs.load(job.id)?.attempts).toBe(0);
  });

  // A retry after the work landed is a second execution, which is the line ADR 0006
  // draws and used to have to guess at.
  test('is not retried when the work had already landed', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });
    h.sandboxes.get(`rc-${job.id}`).startProcessErrorObject = interrupted('runtime_replaced', {
      admitted: true,
    });

    await h.service.tick();

    expect(h.jobs.load(job.id)?.status).toBe('failed');
  });
});

/**
 * The clone failure keeps what the platform said about it.
 *
 * It was the one that did not. The path wraps git's error in a message naming both
 * plausible causes — a missing branch or an installation that does not include the
 * repository — which is worth having, and it was replacing the platform's report
 * rather than carrying it. So `code=` reached the log for every failure except this
 * one, which is the failure most likely to be a platform hiccup during a rollout.
 */
describe('a clone that failed on the platform', () => {
  test('reports the code and context underneath the friendlier message', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });

    const sandbox = h.sandboxes.get(`rc-${job.id}`);
    const platform = new Error('git.clone was interrupted');
    sandbox.cloneErrorObject = Object.assign(platform, {
      toJSON: () => ({
        name: 'OperationInterruptedError',
        message: platform.message,
        code: 'OPERATION_INTERRUPTED',
        operation: 'git.clone',
        context: { reason: 'sandbox_lifetime_changed', retryable: false },
      }),
    });

    await h.service.tick();

    const record = h.jobs.load(job.id)?.toRecord();
    expect(record?.status).toBe('failed');
    // Both halves: the sentence a person needs, and the platform's own words.
    expect(record?.error).toMatch(/Check that the branch exists/);
    expect(record?.error).toMatch(/code=OPERATION_INTERRUPTED/);
    expect(record?.error).toMatch(/"reason":"sandbox_lifetime_changed"/);
  });
})

/**
 * How much history a job clones.
 *
 * The platform clones with `partialclonefilter=blob:none`, which makes a checkout a
 * long run of per-object fetches rather than one transfer — and every interruption
 * observed has landed inside `git.checkout`, the operation with the widest window to
 * be interrupted in. `depth` was available the whole time and no caller passed it.
 *
 * Shallow by default, and settable: an agent that runs `git log` sees one commit, and
 * jobs have done that.
 */
describe('cloning', () => {
  test('takes one commit unless the deployment says otherwise', async () => {
    const h = harness();
    const job = await h.service.createJob({ prompt: 'x' });

    await h.service.tick();

    expect(h.sandboxes.get(`rc-${job.id}`).cloned).toMatchObject({
      repo: CONFIGURED_REPO,
      branch: 'main',
      depth: 1,
    });
  });

  test('takes the whole history when the depth is zero', async () => {
    const h = harness({ policy: policy({ cloneDepth: 0 }) });
    const job = await h.service.createJob({ prompt: 'x' });

    await h.service.tick();

    expect(h.sandboxes.get(`rc-${job.id}`).cloned).not.toHaveProperty('depth');
  });
})

/**
 * What a follow-up turn keeps.
 *
 * A job created with `--pr` pushed and opened one. The turn that answered its
 * question committed and reported "no pull request: nothing was pushed" — the request
 * carried `push: undefined`, which a spread treats as an answer rather than as
 * silence.
 */
describe('continuing a job that was pushing', () => {
  async function pushed(h: Harness): Promise<string> {
    const job = await h.service.createJob({ prompt: 'first', pullRequest: {} });
    const record = h.jobs.load(job.id)!;
    record.recordClaudeSession('session-1');
    record.recordWorkspace({ provider: 'fake', id: 'snap-1' });
    record.settle('completed', h.clock.now());
    h.jobs.save(record);
    return job.id;
  }

  test('keeps pushing when the turn says nothing about it', async () => {
    const h = harness({ policy: policy({ allowPush: true }) });
    const first = await pushed(h);

    // Exactly what the CLI sends when no flags are given: every field present,
    // every value undefined.
    const next = await h.service.continueJob(first, {
      prompt: 'and now this',
      skipChecks: undefined,
      keepSandbox: undefined,
      push: undefined,
    });

    expect(next.options.push).toBe(true);
    expect(next.toRecord().pullRequest).toEqual({});
  });

  test('starts pushing when the turn asks for a pull request', async () => {
    const h = harness({ policy: policy({ allowPush: true }) });
    const job = await h.service.createJob({ prompt: 'first' });
    const record = h.jobs.load(job.id)!;
    record.recordClaudeSession('session-1');
    record.recordWorkspace({ provider: 'fake', id: 'snap-1' });
    record.settle('completed', h.clock.now());
    h.jobs.save(record);

    const next = await h.service.continueJob(job.id, {
      prompt: 'open one this time',
      pullRequest: {},
    });

    // Implied at creation and not here, so this asked for a pull request and got
    // neither it nor a push.
    expect(next.options.push).toBe(true);
  });
})
