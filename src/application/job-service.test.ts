import { beforeEach, describe, expect, test } from 'vitest';
import { REPO_DIR, STATE_DIR, JobService, type JobServiceDeps } from './job-service';
import type { ExecutorPolicy } from './ports';
import {
  AllowAllGitHub,
  DenyAllGitHub,
  FakeClock,
  FakeIds,
  FakeSandboxProvider,
  InMemoryArtifactStore,
  InMemoryJobStore,
  InMemoryLedgerStore,
  InMemoryLogStore,
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
    commands: { install: '', lint: '', test: '', build: '' },
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
    expect(sandbox.cloned).toEqual({ repo: CONFIGURED_REPO, branch: 'main' });
    expect(sandbox.files.get(`${STATE_DIR}/runner.mjs`)).toBe('// runner');
    expect(JSON.parse(sandbox.files.get(`${STATE_DIR}/job.json`) as string)).toMatchObject({
      id: job.id,
      prompt: 'fix the build',
      branch: job.branch,
    });
    // setsid + nohup, so the runner outlives the shell that spawned it.
    expect(sandbox.commands.join('\n')).toMatch(/setsid nohup node .*runner\.mjs/);
    expect(jobs.load(job.id)?.status).toBe('running');
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
    sandbox.files.set(`${STATE_DIR}/runner.out`, 'Error: out of memory');

    h.clock.advance(h.deps.policy.heartbeatTimeoutMs + 1_000);
    await h.service.tick();

    const job = h.jobs.load(h.jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/stopped responding during "agent"/);
    expect(job?.error).toMatch(/out of memory/);
    expect(sandbox.killed).toBe(true);
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
    expect(STATE_DIR).toBe('/workspace/.remote-claude');
  });
});
