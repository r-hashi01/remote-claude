import {
  describeUpdate,
  translateEvent,
  type AgentUsage,
  type ClaudeStreamEvent,
} from '../domain/agent/acp';
import { assessRunnerHealth, exceededDeadline } from '../domain/job/health';
import { NotFound, Refusal } from '../domain/job/errors';
import { Job } from '../domain/job/job';
import type {
  JobCommands,
  JobRecord,
  JobRequest,
  JobResult,
  JobSummary,
  LogLine,
  PullRequestRequest,
} from '../domain/job/record';
import { composePullRequest } from '../domain/job/pull-request';
import { resolveRepository } from '../domain/job/repository';
import {
  shouldRetryLaunch,
  shouldRetrySilentStartup,
} from '../domain/job/retry';
import {
  sandboxIdForJob,
  shouldReclaim,
  summariseLedger,
  type SandboxLedger,
} from '../domain/sandbox/ledger';
import type {
  ArtifactStore,
  Clock,
  ExecutorPolicy,
  GitHubAccess,
  JobIdFactory,
  JobStore,
  LogStore,
  Redact,
  RunningJobs,
  SandboxLedgerStore,
  SandboxProvider,
  SandboxSession,
  Scheduler,
} from './ports';
import { REPO_DIR, STATE_DIR, WORKSPACE_DIR } from './workspace';

// Re-exported because these are part of this module's story (the runner contract
// lives here) while the values themselves are shared with the session path.
export { REPO_DIR, STATE_DIR } from './workspace';

/** How often to mirror a running job's state files into this executor. */
export const POLL_INTERVAL_MS = 2_000;

/**
 * Backstop interval for the orphan sweep.
 *
 * Short on purpose: orphans consume max_instances, so a leak blocks the queue
 * rather than merely costing money, and the alarm is cheap.
 */
export const SWEEP_INTERVAL_MS = 60 * 1000;

/** How much of the runner's own output to quote when it dies. */
const RUNNER_OUTPUT_TAIL = 2_000;

/** What a follow-up turn may say for itself. Everything else is inherited. */
export interface ContinueRequest {
  prompt: string;
  skipChecks?: boolean;
  keepSandbox?: boolean;
  push?: boolean;
  commands?: Partial<JobCommands>;
  pullRequest?: PullRequestRequest;
}

export interface JobServiceDeps {
  policy: ExecutorPolicy;
  clock: Clock;
  ids: JobIdFactory;
  jobs: JobStore;
  logs: LogStore;
  artifacts: ArtifactStore;
  ledger: SandboxLedgerStore;
  sandboxes: SandboxProvider;
  github: GitHubAccess;
  scheduler: Scheduler;
  running: RunningJobs;
  redact: Redact;
  /** The runner shipped into the container with each job (ADR 0007). */
  runnerSource: string;
  /**
   * Environment for the runner process.
   *
   * Supplied by the infrastructure layer because it is where the credential
   * posture is decided (ADR 0002) — in proxy mode the container receives a
   * sentinel and the real token is swapped in on the way out. Absent under test,
   * where there are no credentials to get wrong.
   */
  containerEnvironment?: () => Record<string, string | undefined>;
}

/**
 * Running jobs, as a use case rather than as a Durable Object.
 *
 * This is the whole execution story: accept a job, start it in a sandbox, mirror
 * what the container reports, decide whether the runner is alive, settle it, and
 * give the sandbox back. Every one of those decisions is made from domain rules
 * (`src/domain`) over ports (`./ports`), so the story can be told to a Map as
 * easily as to workerd — which is what `job-service.test.ts` does.
 *
 * What used to be here and is not: SQL, R2 keys, alarms, HTTP status codes, and
 * the Cloudflare Sandbox SDK. Those live in `src/infrastructure`, on the other
 * side of the ports.
 */
export class JobService {
  private readonly deps: JobServiceDeps;
  /** Jobs adopted from a previous incarnation, pending a liveness check. */
  private readonly recovered = new Set<string>();

  constructor(deps: JobServiceDeps) {
    this.deps = deps;
  }

  // ------------------------------------------------------------------ reads

  getJob(id: string): Job | null {
    return this.deps.jobs.load(id);
  }

  listJobs(limit: number): JobRecord[] {
    return this.deps.jobs.listRecent(limit).map((job) => job.toRecord());
  }

  listJobSummaries(limit: number): JobSummary[] {
    return this.deps.jobs.listRecent(limit).map((job) => job.toSummary());
  }

  getLogs(id: string, since: number, limit: number): LogLine[] {
    return this.deps.logs.read(id, since, limit);
  }

  getPatch(id: string): Promise<string | null> {
    return this.deps.artifacts.getPatch(id);
  }

  listSandboxes(): SandboxLedger {
    return summariseLedger(this.deps.ledger.list(100), this.deps.running.ids());
  }

  // ----------------------------------------------------------------- writes

  /**
   * Accept a job.
   *
   * Returns before anything is cloned: starting a job takes tens of seconds, and
   * doing that inside this call blocked the caller and risked being interrupted
   * mid-clone. The scheduled wake-up picks it up.
   */
  async createJob(request: JobRequest): Promise<Job> {
    const { policy, clock, ids, jobs, github, scheduler } = this.deps;

    const { repo, isCustom } = resolveRepository(
      request.repo,
      policy.repoUrl,
      policy.allowCustomRepo,
    );
    // Asked before the job exists, so an unreachable repository is a refusal at
    // this call rather than a job that fails minutes later on clone.
    if (isCustom) await github.assertRepositoryReachable(repo);

    // Refused rather than quietly dropped. ALLOW_PUSH was read into config and
    // then never consulted, so a caller could ask for a push on a deployment
    // that was configured to forbid it and the runner would try — and a caller
    // who asked for a push and got a branch that was never pushed has been
    // misinformed either way.
    // A pull request needs a branch on the remote, so asking for one asks for a
    // push. Refusing the combination would be pedantic; the checks below are the
    // same either way.
    const wantsPush =
      request.push === true || request.pullRequest !== undefined;

    if (wantsPush) {
      if (!policy.allowPush) {
        throw new Refusal(
          'this executor will not push: pushing is disabled on it. Set ALLOW_PUSH=true in its ' +
            'wrangler.jsonc vars and give its GitHub App Contents: Read and write, or fetch the ' +
            'diff and apply it yourself.',
        );
      }
      // The switch says this deployment is willing; GitHub says whether it can.
      await github.assertRepositoryWritable(repo);
    }
    if (request.pullRequest) await github.assertCanOpenPullRequests(repo);

    const job = Job.create({
      id: ids.next(),
      prompt: request.prompt,
      repo,
      baseBranch: request.baseBranch || policy.defaultBaseBranch,
      branch: request.branch,
      options: {
        skipChecks: request.skipChecks === true,
        keepSandbox: request.keepSandbox === true,
        push: wantsPush,
      },
      commands: request.commands,
      pullRequest: request.pullRequest,
      now: clock.now(),
    });

    this.prune();
    jobs.save(job);
    await scheduler.scheduleIn(0);
    return job;
  }

  /**
   * A follow-up turn on a finished job.
   *
   * Everything about what is inherited lives in `Job.continuing`; this is the
   * queueing around it. The refusals are the interesting part, and they all say
   * the same thing in different words: a continuation that quietly becomes a
   * fresh start is worse than one that does not happen.
   */
  async continueJob(previousId: string, request: ContinueRequest): Promise<Job> {
    const { jobs, clock, ids, scheduler } = this.deps;

    const previous = jobs.load(previousId);
    if (!previous) throw new NotFound(`job ${previousId} is not one this executor knows about`);

    const job = Job.continuing(previous, {
      id: ids.next(),
      prompt: request.prompt,
      options: {
        skipChecks: request.skipChecks,
        keepSandbox: request.keepSandbox,
        push: request.push,
      },
      commands: request.commands,
      pullRequest: request.pullRequest,
      now: clock.now(),
    });

    this.prune();
    jobs.save(job);
    this.log(job.id, 'system', `continuing job ${previousId} on ${job.branch}`);
    this.deps.logs.flush(job.id);
    await scheduler.scheduleIn(0);
    return job;
  }

  async cancelJob(id: string): Promise<Job | null> {
    const { jobs, logs, clock, running } = this.deps;
    const job = jobs.load(id);
    if (!job) return null;

    if (job.status === 'queued') {
      job.settle('cancelled', clock.now());
      jobs.save(job);
      this.log(id, 'system', 'job cancelled before it started');
      logs.flush(id);
      return job;
    }

    if (running.requestCancel(id)) {
      // The next poll observes this, kills the container processes and settles.
      this.log(id, 'system', 'cancellation signal sent');
      logs.flush(id);
      return jobs.load(id);
    }

    return job; // already finished
  }

  /**
   * Adopt jobs left in flight by a previous incarnation.
   *
   * They are NOT presumed dead. When the pipeline ran in the executor an
   * eviction really did kill the work, so failing them was honest; since it
   * moved into the container (ADR 0004) the runner survives a restart here, and
   * failing those jobs threw away work that was still going. The first poll
   * reads the container's own status and decides.
   */
  adopt(): void {
    for (const job of this.deps.jobs.listByStatus(['starting', 'running'])) {
      this.deps.running.begin(job.id);
      this.recovered.add(job.id);
    }
  }

  /**
   * Give back sandboxes whose job is over.
   *
   * Public because the right moment to run it is when the executor starts: it is
   * constructed immediately after the eviction that orphaned them.
   */
  async reclaimOrphans(): Promise<void> {
    await this.sweepOrphans();
  }

  /**
   * One wake-up: start what is waiting, follow what is running, reclaim what is
   * finished. Each firing is a fresh invocation with a fresh CPU budget, which
   * is what lets a job run arbitrarily long (ADR 0004).
   */
  async tick(): Promise<void> {
    try {
      await this.drain();
      for (const jobId of this.deps.running.ids()) {
        try {
          await this.pollJob(jobId);
        } catch (error) {
          // One unhealthy job must not stop the others or the sweep.
          this.log(jobId, 'system', `poll failed: ${errorMessage(error)}`);
          this.deps.logs.flush(jobId);
        }
      }
      await this.sweepOrphans();
    } finally {
      // Poll fast while work is in flight or waiting, idle slowly otherwise.
      const busy =
        this.deps.running.size > 0 || this.deps.jobs.countQueued() > 0;
      await this.deps.scheduler.scheduleIn(
        busy ? POLL_INTERVAL_MS : SWEEP_INTERVAL_MS,
      );
    }
  }

  // ------------------------------------------------------------- scheduling

  /**
   * Start queued jobs up to the concurrency limit.
   *
   * The queue is read from storage rather than held in memory: an executor that
   * restarts would otherwise silently drop everything waiting.
   */
  private async drain(): Promise<void> {
    const { jobs, running, policy } = this.deps;
    for (const job of jobs.listQueued()) {
      if (running.size >= policy.maxConcurrency) break;
      if (running.has(job.id)) continue;
      await this.launch(job);
    }
  }

  /**
   * Start a job, and return as soon as the container runner is up.
   *
   * The pipeline itself lives in the container (ADR 0004): this side gets 30
   * seconds of CPU between requests, which capped jobs at roughly 51 seconds
   * when the pipeline ran from here.
   */
  private async launch(job: Job): Promise<void> {
    const { policy, clock, jobs, ledger, sandboxes, scheduler, running } =
      this.deps;

    running.begin(job.id);
    job.start(clock.now());
    jobs.save(job);

    try {
      const sandboxId = sandboxIdForJob(job.id);
      ledger.record(sandboxId, job.id, clock.now());

      const sandbox = await sandboxes.create(sandboxId, {
        sleepAfter: policy.sleepAfter,
      });

      // A job that continues another starts from that job's workspace: the tree
      // it left and the conversation about it. Falling back to a clone would
      // silently turn a follow-up turn into a fresh start, so it fails instead.
      const restored = await this.restoreWorkspace(job, sandbox);

      // Cloning stays on this side: it needs credentials injected outside the
      // container, which is the whole point of ADR 0002.
      if (!restored) {
        this.log(job.id, 'system', `cloning ${job.repo} (${job.baseBranch})`);
        try {
          await sandbox.cloneRepository(job.repo, {
            branch: job.baseBranch,
            targetDir: REPO_DIR,
          });
        } catch (error) {
          // git's own message is about a URL and a credential and says nothing
          // about which of the two plausible causes it is. Access is confirmed
          // before a custom repository is accepted, so by here the branch is the
          // likelier one — but name both rather than guess.
          throw new Error(
            `cloning ${job.repo} at branch "${job.baseBranch}" failed: ${errorMessage(error)}. ` +
              'Check that the branch exists and that the GitHub App installation includes this repository.',
          );
        }
      }

      await sandbox.writeFile(
        `${STATE_DIR}/job.json`,
        JSON.stringify({
          id: job.id,
          prompt: job.toRecord().prompt,
          branch: job.branch,
          baseBranch: job.baseBranch,
          options: job.options,
          // Set only on a follow-up turn: the runner passes it to `--resume`, so
          // the agent carries on the conversation instead of meeting the work for
          // the first time.
          resumeSession: job.resumeSession,
          // The deployment's commands, with this job's overrides on top. The
          // install step is not covered by skipChecks, so a job on another
          // repository has to be able to replace it.
          commands: job.resolveCommands(policy.commands),
          stepTimeoutMs: policy.jobTimeoutMs,
          claudeTimeoutMs: policy.claudeTimeoutMs,
        }),
      );

      // Ship the runner with the job rather than relying on the image. One
      // artifact, so no drift (ADR 0007).
      await sandbox.writeFile(
        `${STATE_DIR}/runner.mjs`,
        this.deps.runnerSource,
      );

      // setsid + nohup so the runner outlives the shell this exec spawned. The
      // marker is written first and separately: when a runner dies without
      // printing anything, the only remaining question is whether this shell ran
      // at all, and nothing in the sandbox could answer it.
      await sandbox.exec(
        `mkdir -p ${STATE_DIR} && date -u +%Y-%m-%dT%H:%M:%SZ > ${STATE_DIR}/launched && ` +
          `setsid nohup node ${STATE_DIR}/runner.mjs ${STATE_DIR} ` +
          `> ${STATE_DIR}/runner.out 2>&1 < /dev/null &`,
        {
          cwd: '/workspace',
          env: this.deps.containerEnvironment?.() ?? {},
          timeoutMs: 30_000,
        },
      );

      job.markRunning();
      jobs.save(job);
      this.log(job.id, 'system', 'runner started in container');
      await scheduler.scheduleIn(POLL_INTERVAL_MS);
    } catch (error) {
      const message = errorMessage(error);

      // Safe to retry here and only here: the runner has not started, so
      // nothing has run and re-running has no side effects.
      if (shouldRetryLaunch(message, job.attempts)) {
        const attempts = job.attempts + 1;
        running.end(job.id);
        await this.teardown(job.id);

        const current = jobs.load(job.id) ?? job;
        current.requeue({ attempts });
        jobs.save(current);
        this.log(
          job.id,
          'system',
          `platform interrupted the start (attempt ${attempts}); requeued: ${message}`,
        );
        await scheduler.scheduleIn(POLL_INTERVAL_MS);
        return;
      }

      await this.settle(job.id, 'failed', message);
    }
  }

  /**
   * Start from another job's workspace, when this job continues one.
   *
   * Returns false when there is nothing to restore, so the caller clones. A
   * restore that was asked for and failed throws: continuing from a fresh clone
   * would look like continuing and behave like starting over.
   */
  private async restoreWorkspace(
    job: Job,
    sandbox: SandboxSession,
  ): Promise<boolean> {
    const from = job.restoreFrom;
    if (!from) return false;

    this.log(
      job.id,
      'system',
      'restoring the workspace of the job this continues',
    );
    if (await sandbox.restore(from)) return true;

    throw new Error(
      'the workspace of the job this continues could not be restored, so there is ' +
        'nothing to continue. It may have expired: workspaces are kept for as long ' +
        'as the job record, and no longer.',
    );
  }

  /**
   * Read one running job's state files and mirror them into storage.
   */
  private async pollJob(jobId: string): Promise<void> {
    const { policy, clock, jobs, sandboxes, running } = this.deps;

    const job = jobs.load(jobId);
    if (!job || job.isTerminal) {
      running.end(jobId);
      return;
    }

    if (running.isCancelled(jobId)) {
      await this.stopContainer(jobId);
      await this.settle(jobId, 'cancelled', 'cancelled by request');
      return;
    }

    const overdue = exceededDeadline({
      now: clock.now(),
      startedAt: job.startedAt,
      jobTimeoutMs: policy.jobTimeoutMs,
    });
    if (overdue) {
      await this.stopContainer(jobId);
      await this.settle(jobId, 'failed', overdue);
      return;
    }

    const sandbox = await sandboxes.create(sandboxIdForJob(jobId));

    // An adopted job may have been killed before its runner ever started.
    // status.json is written by the runner, so its absence answers that.
    if (this.recovered.delete(jobId)) {
      const alive = await sandbox.readFile(`${STATE_DIR}/status.json`);
      if (!alive) {
        this.log(
          jobId,
          'system',
          'worker restarted before the runner started; requeued',
        );
        running.end(jobId);
        await this.teardown(jobId);
        const current = jobs.load(jobId);
        if (current) {
          current.requeue();
          jobs.save(current);
        }
        return;
      }
      this.log(
        jobId,
        'system',
        'resumed after worker restart; runner still running',
      );
    }

    // Mirroring must never decide whether a job can finish. It used to run
    // before the status read with nothing catching it, so one failure in the log
    // path left the job polling until it hit its timeout — a job lost to a
    // problem with reporting on the job.
    await this.tryMirrorLogs(jobId, sandbox);

    const status = await this.readStatus(sandbox);
    if (status?.phase === 'completed' || status?.phase === 'failed') {
      await this.finalize(jobId, sandbox, status.phase);
      return;
    }

    // Re-read before judging liveness. `job` above was loaded before mirroring,
    // and mirroring is exactly what advances progress — so the checks below
    // would decide using a snapshot of the moment before the evidence arrived.
    // One job was killed by the very poll that collected its 444 lines of output.
    const fresh = jobs.load(jobId) ?? job;
    const health = assessRunnerHealth({
      now: clock.now(),
      startedAt: fresh.startedAt,
      lastProgressAt: fresh.lastProgressAt,
      heartbeatAt: status?.updatedAt,
      phase: status?.phase,
      stallTimeoutMs: policy.stallTimeoutMs,
      heartbeatTimeoutMs: policy.heartbeatTimeoutMs,
    });

    if (health.kind === 'stalled') {
      await this.stopContainer(jobId);
      await this.settle(jobId, 'failed', health.reason);
      return;
    }

    if (health.kind === 'unresponsive') {
      // The runner's own stdout/stderr is the only thing that can say why it
      // died. We were holding it the whole time and not reading it — knowing a
      // great deal about the runner's internals while failing to report the one
      // thing anyone needs.
      const output =
        (await sandbox.readFile(`${STATE_DIR}/runner.out`))?.trim() ?? '';

      // A runner that wrote no status and printed nothing executed nothing, so
      // this is still the pre-runner window and a retry has no side effects.
      if (
        shouldRetrySilentStartup({
          runnerReportedStatus: status !== undefined,
          runnerOutput: output,
          attemptsSoFar: fresh.attempts,
        })
      ) {
        const attempts = fresh.attempts + 1;
        this.log(
          jobId,
          'system',
          `runner started and reported nothing (attempt ${attempts}); requeued`,
        );
        running.end(jobId);
        await this.teardown(jobId);
        const current = jobs.load(jobId);
        if (current) {
          current.requeue({ attempts });
          jobs.save(current);
        }
        return;
      }

      // Nothing to quote, so say which half of the start failed instead. The
      // marker is written by the shell before it starts the runner: present means
      // the command ran and the runner said nothing, absent means the command
      // itself never got that far.
      const launched = (
        await sandbox.readFile(`${STATE_DIR}/launched`)
      )?.trim();
      const detail = output
        ? `\nrunner output:\n${output.slice(-RUNNER_OUTPUT_TAIL)}`
        : launched
          ? ` The launcher ran at ${launched} but the runner printed nothing.`
          : ' No launch marker was written, so the start command itself may never have run.';

      await this.stopContainer(jobId);
      await this.settle(jobId, 'failed', `${health.reason}${detail}`);
    }
  }

  private async readStatus(
    sandbox: SandboxSession,
  ): Promise<
    { phase?: 'completed' | 'failed' | string; updatedAt?: number } | undefined
  > {
    const raw = await sandbox.readFile(`${STATE_DIR}/status.json`);
    return raw
      ? (JSON.parse(raw) as { phase?: string; updatedAt?: number })
      : undefined;
  }

  /** Mirror logs, surfacing any failure without letting it stall the job. */
  private async tryMirrorLogs(
    jobId: string,
    sandbox: SandboxSession,
  ): Promise<void> {
    try {
      await this.mirrorLogs(jobId, sandbox);
    } catch (error) {
      this.log(jobId, 'system', `log mirroring failed: ${errorMessage(error)}`);
      // Flush immediately: a buffered report of a logging failure is a report
      // that disappears exactly when it is needed.
      this.deps.logs.flush(jobId);
    }
  }

  /**
   * Copy log lines written since the last poll into storage.
   *
   * Line numbers and seq numbers align: the runner writes one line per seq.
   */
  private async mirrorLogs(
    jobId: string,
    sandbox: SandboxSession,
  ): Promise<void> {
    const { jobs, logs, clock } = this.deps;
    const job = jobs.load(jobId);
    if (!job) return;

    const since = job.logSeq + 1;
    const tail = await sandbox.exec(
      `tail -n +${since} ${STATE_DIR}/log.ndjson 2>/dev/null || true`,
      { timeoutMs: 20_000 },
    );

    let highest = job.logSeq;
    for (const line of (tail.stdout ?? '').split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as {
          seq: number;
          stream: string;
          line: string;
        };
        highest = Math.max(highest, entry.seq);

        if (entry.stream === 'agent') {
          // Raw agent events, interpreted by the same translator the ACP surface
          // uses. The container emits facts; meaning is assigned once.
          const translated = translateEvent(
            JSON.parse(entry.line) as ClaudeStreamEvent,
          );
          for (const update of translated.updates) {
            const rendered = describeUpdate(update);
            if (rendered) this.log(jobId, 'stdout', rendered);
          }
          if (
            translated.usage ||
            translated.finalText ||
            translated.claudeSessionId
          ) {
            this.recordOutcome(
              jobId,
              translated.usage,
              translated.finalText,
              translated.claudeSessionId,
            );
          }
          continue;
        }

        this.log(jobId, entry.stream as LogLine['stream'], entry.line);
      } catch {
        // A partially written final line; it arrives complete next poll.
      }
    }

    // Flush within the poll rather than carrying a buffer across polls: between
    // wake-ups this executor is idle and may be evicted, and anything still
    // buffered would be lost — which is exactly how the tail of a job's log kept
    // disappearing. Batching still pays off, one write per poll instead of one
    // per line.
    logs.flush(jobId);

    if (highest !== job.logSeq) {
      const current = jobs.load(jobId);
      if (current) {
        // New output is the progress signal; nothing separate is needed.
        current.recordProgress(clock.now(), highest);
        jobs.save(current);
      }
    }
  }

  /** Pull the runner's artifacts across and settle the job. */
  private async finalize(
    jobId: string,
    sandbox: SandboxSession,
    phase: 'completed' | 'failed',
  ): Promise<void> {
    const { artifacts, redact } = this.deps;

    // Drain once more before settling. The runner can write its last lines
    // between the poll's tail and its status read, and losing the tail of a log
    // is what previously made a failure look like it happened earlier than it did.
    await this.tryMirrorLogs(jobId, sandbox);

    const resultRaw = await sandbox.readFile(`${STATE_DIR}/result.json`);
    const patchRaw = (await sandbox.readFile(`${STATE_DIR}/patch.diff`)) ?? '';

    // Second redaction layer. The container cannot do value-based redaction —
    // it does not hold the secrets (ADR 0002) — so it happens here.
    await artifacts.putPatch(jobId, redact(patchRaw));

    let result: JobResult | undefined;
    let error: string | undefined;
    if (resultRaw) {
      const { error: reported, ...parsed } = JSON.parse(
        redact(resultRaw),
      ) as JobResult & {
        error?: string;
      };
      // The result is kept in both cases. A failure used to arrive as one line of
      // `error` with the steps thrown away — so the one situation that needs to
      // say which command ran and what it printed was the situation that said
      // least.
      //
      // The reason itself is lifted out rather than left inside: the record has
      // a place for it, and the same fact in two places is how one of them goes
      // stale. The runner's own file keeps everything, in R2.
      result = parsed;
      if (reported) error = reported;
      await artifacts.putResult(jobId, redact(resultRaw));
    }

    await this.settle(
      jobId,
      phase === 'completed' ? 'completed' : 'failed',
      error,
      result,
    );
    if (phase === 'completed') await this.tryOpenPullRequest(jobId);
  }

  /**
   * Open the pull request this job asked for.
   *
   * After settling, deliberately: the job is finished either way. A pull request
   * that cannot be opened is reported and nothing more — the branch is pushed, so
   * the work is not lost, and failing a completed job over the paperwork would
   * throw away a result that exists.
   */
  private async tryOpenPullRequest(jobId: string): Promise<void> {
    const { jobs, logs, github } = this.deps;
    const job = jobs.load(jobId);
    if (!job?.pullRequestRequest) return;

    const record = job.toRecord();
    if (!record.result?.pushed) {
      this.log(jobId, 'system', 'no pull request: nothing was pushed');
      logs.flush(jobId);
      return;
    }

    const content = composePullRequest(record, record.result);
    try {
      const url = await github.openPullRequest({
        repo: record.repo,
        head: record.branch,
        base: record.baseBranch,
        ...content,
      });
      const current = jobs.load(jobId);
      if (current) {
        current.recordPullRequest(url);
        jobs.save(current);
      }
      this.log(jobId, 'system', `pull request opened: ${url}`);
    } catch (error) {
      this.log(
        jobId,
        'system',
        `pull request could not be opened: ${errorMessage(error)}. ` +
          `The branch ${record.branch} is pushed; open it by hand.`,
      );
    }
    logs.flush(jobId);
  }

  private async settle(
    jobId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error?: string,
    result?: JobResult,
  ): Promise<void> {
    const { jobs, logs, clock, redact, running } = this.deps;

    const job = jobs.load(jobId);
    const reason = error ? redact(error) : undefined;
    if (job?.settle(status, clock.now(), { error: reason, result })) {
      jobs.save(job);
      this.log(jobId, 'system', `job ${status}${reason ? `: ${reason}` : ''}`);
    }

    logs.flush(jobId);
    running.end(jobId);
    // Before the sandbox goes: whatever this job leaves behind has to be taken
    // out of it first.
    await this.carryWorkspace(jobId);
    if (!job?.options.keepSandbox) await this.teardown(jobId);
    await this.drain();
  }

  /**
   * Store the tree and the conversation, so this job can be continued.
   *
   * Kept for as long as the job record is, because a workspace whose job has
   * been pruned is a pointer to something nobody can ask about. Never fatal: a
   * job that has produced its diff is finished whether or not it can be resumed,
   * and the failure is reported rather than swallowed.
   *
   * `.gitignore` is respected, so what travels is the working tree and the
   * conversation beside it — not a reinstalled `node_modules`.
   */
  private async carryWorkspace(jobId: string): Promise<void> {
    const { jobs, sandboxes, policy } = this.deps;
    const job = jobs.load(jobId);
    if (!job) return;

    try {
      const sandbox = await sandboxes.create(sandboxIdForJob(jobId));
      const workspace = await sandbox.snapshot({
        dir: WORKSPACE_DIR,
        name: `job-${jobId}`,
        ttlSeconds: Math.round(policy.retentionMs / 1000),
        // Named rather than inferred: git rules apply only inside a repository,
        // and this directory is one above it.
        excludes: ['node_modules'],
      });

      // Null means no store is configured for this deployment. That is a
      // deployment's choice, not a failure, and it is already visible as the
      // absence of a workspace on the record.
      if (!workspace) return;

      const current = jobs.load(jobId);
      if (current) {
        current.recordWorkspace(workspace);
        jobs.save(current);
      }
    } catch (error) {
      this.log(
        jobId,
        'system',
        `the workspace could not be kept: ${errorMessage(error)}`,
      );
      this.deps.logs.flush(jobId);
    }
  }

  private async stopContainer(jobId: string): Promise<void> {
    try {
      const sandbox = await this.deps.sandboxes.create(sandboxIdForJob(jobId));
      await sandbox.killAll();
    } catch {
      // Nothing to stop.
    }
  }

  /**
   * Record what the agent's turn ended with.
   *
   * Written as it arrives rather than at finalize, so a job that later fails
   * still reports what it consumed and what it last said.
   */
  private recordOutcome(
    jobId: string,
    usage?: AgentUsage,
    finalText?: string,
    claudeSessionId?: string,
  ): void {
    const { jobs, redact } = this.deps;
    const job = jobs.load(jobId);
    if (!job) return;

    if (usage) job.recordUsage(usage);
    if (finalText) job.recordFinalText(redact(finalText));
    // Arrives in the first event of every run and was discarded until now. It is
    // the only handle on the conversation a follow-up turn would continue.
    if (claudeSessionId) job.recordClaudeSession(claudeSessionId);
    jobs.save(job);

    if (usage) {
      this.log(
        jobId,
        'system',
        `usage: ${usage.inputTokens} in / ${usage.outputTokens} out` +
          (usage.turns ? `, ${usage.turns} turns` : ''),
      );
    }
  }

  // ---------------------------------------------------- sandbox lifecycle

  /**
   * Destroy a job's sandbox and record the outcome. Never throws.
   *
   * Failures are recorded rather than swallowed: a sandbox that repeatedly
   * refuses to go away is exactly the thing the ledger exists to surface.
   */
  private async teardown(jobId: string): Promise<void> {
    const { ledger, sandboxes, jobs, clock } = this.deps;
    const sandboxId = sandboxIdForJob(jobId);
    ledger.countTeardownAttempt(sandboxId);

    try {
      const sandbox = await sandboxes.create(sandboxId);
      await sandbox.destroy();
    } catch (error) {
      ledger.markTeardownError(sandboxId, errorMessage(error).slice(0, 500));
      return;
    }

    ledger.markDestroyed(sandboxId, clock.now());
    this.log(jobId, 'system', 'sandbox destroyed');

    const job = jobs.load(jobId);
    if (job) {
      job.markSandboxDestroyed();
      jobs.save(job);
    }
  }

  /**
   * Reclaim sandboxes whose job has finished but which were never torn down.
   *
   * Necessary because this executor can be evicted mid-job, in which case the
   * settling path never runs. Observed in practice: four failed jobs left three
   * live containers, exactly filling max_instances and blocking the queue.
   */
  private async sweepOrphans(): Promise<void> {
    const { ledger, jobs, running, clock } = this.deps;

    for (const jobId of ledger.outstandingJobIds()) {
      if (running.has(jobId)) continue;
      const job = jobs.load(jobId);
      if (!job) continue;

      const record = job.toRecord();
      const reclaim = shouldReclaim({
        now: clock.now(),
        jobIsTerminal: job.isTerminal,
        jobIsRunning: false,
        keepSandbox: job.options.keepSandbox,
        finishedAt: record.finishedAt ?? record.createdAt,
      });
      if (reclaim) await this.teardown(jobId);
    }
  }

  // ------------------------------------------------------------- retention

  private prune(): void {
    const { jobs, logs, running, clock, policy } = this.deps;
    const cutoff = clock.now() - policy.retentionMs;
    for (const id of jobs.idsCreatedBefore(cutoff)) {
      if (running.has(id)) continue;
      logs.removeFor(id);
      jobs.remove(id);
    }
  }

  private log(jobId: string, stream: LogLine['stream'], line: string): void {
    this.deps.logs.append(jobId, stream, line);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
