import { DurableObject } from 'cloudflare:workers';
import {
  JobService,
  SWEEP_INTERVAL_MS,
  type ContinueRequest,
} from '../../application/job-service';
import { claudeProcessEnvironment } from '../../domain/agent/environment';
import type { JobRecord, JobRequest, JobSummary, LogLine } from '../../domain/job/record';
import type { SandboxLedger } from '../../domain/sandbox/ledger';
import { createRedactor } from '../../domain/redaction/redactor';
import { loadConfig } from '../config';
import type { Env } from '../env';
import { GitHubAppAccess } from '../github/app';
import { R2ArtifactStore } from '../persistence/r2-artifact-store';
import {
  migrate,
  SqliteJobStore,
  SqliteLedgerStore,
  SqliteLogStore,
} from '../persistence/sqlite-stores';
import { RunningJobRegistry } from '../running-jobs';
import { maskedSecrets } from '../secrets';
import { RUNNER_SOURCE } from '../runner-source';
import { getSandboxProvider } from '../sandbox';

/**
 * The executor, as the platform sees it.
 *
 * Exactly one instance exists, which is what makes the concurrency counter
 * trivially correct. Everything it does is `JobService` (see
 * `src/application/job-service.ts`); this class supplies the ports — SQLite,
 * R2, the container platform, GitHub, the alarm, the clock — and translates RPC
 * in and records out.
 *
 * It knows about *jobs*, and deliberately nothing about what the caller is using
 * them for. Projects, work items and their statuses belong to the product on the
 * other side of this API (ADR 0003).
 */
export class JobManager extends DurableObject<Env> {
  private readonly service: JobService;
  private readonly running = new RunningJobRegistry();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const sql = ctx.storage.sql;
    const config = loadConfig(env);

    this.service = new JobService({
      policy: config,
      clock: { now: () => Date.now() },
      ids: { next: newJobId },
      jobs: new SqliteJobStore(sql),
      logs: new SqliteLogStore(sql),
      artifacts: new R2ArtifactStore(env.ARTIFACTS),
      ledger: new SqliteLedgerStore(sql),
      sandboxes: getSandboxProvider(env),
      github: new GitHubAppAccess(env),
      scheduler: {
        scheduleIn: async (delayMs) => {
          await ctx.storage.setAlarm(Date.now() + delayMs);
        },
      },
      running: this.running,
      redact: createRedactor(maskedSecrets(env)),
      runnerSource: RUNNER_SOURCE,
      containerEnvironment: () =>
        claudeProcessEnvironment({
          authMode: config.claudeAuthMode,
          oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
          ci: true,
        }),
    });

    ctx.blockConcurrencyWhile(async () => {
      migrate(sql);
      this.service.adopt();

      // Arm the backstop. The reclaim below runs now rather than waiting for it:
      // this object is constructed right after the eviction that orphaned those
      // sandboxes, so this is the moment to get them back.
      await ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);

      // Deliberately not awaited inside blockConcurrencyWhile: reclaiming talks
      // to the container platform and can be slow, and nothing should be unable
      // to read a job list because a cleanup is in flight.
      ctx.waitUntil(this.service.reclaimOrphans());
    });
  }

  // ------------------------------------------------------------------ RPC
  //
  // Records rather than domain objects: these cross an RPC boundary, so they
  // have to be plain data.

  async createJob(request: JobRequest): Promise<JobRecord> {
    return (await this.service.createJob(request)).toRecord();
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return this.service.getJob(id)?.toRecord() ?? null;
  }

  async listJobs(limit = 20): Promise<JobRecord[]> {
    return this.service.listJobs(limit);
  }

  /**
   * The same list, without each job's captured step output.
   *
   * The dashboard polls this every few seconds. Whole records once shipped over
   * a megabyte per refresh to render a status and a prompt.
   */
  async listJobSummaries(limit = 20): Promise<JobSummary[]> {
    return this.service.listJobSummaries(limit);
  }

  async getLogs(id: string, since = 0, limit = 2000): Promise<LogLine[]> {
    return this.service.getLogs(id, since, limit);
  }

  async getPatch(id: string): Promise<string | null> {
    return this.service.getPatch(id);
  }

  /** A follow-up turn on a finished job. Returns the new job. */
  async continueJob(previousId: string, request: ContinueRequest): Promise<JobRecord> {
    return (await this.service.continueJob(previousId, request)).toRecord();
  }

  async cancelJob(id: string): Promise<JobRecord | null> {
    return (await this.service.cancelJob(id))?.toRecord() ?? null;
  }

  /**
   * What this deployment has allocated and whether it got it back.
   *
   * Exists because no external metric can answer that: the container platform
   * reports provisioned capacity, not running instances.
   */
  async listSandboxes(): Promise<SandboxLedger> {
    return this.service.listSandboxes();
  }

  /** Everything periodic. Each firing is a fresh CPU budget (ADR 0004). */
  async alarm(): Promise<void> {
    await this.service.tick();
  }
}

function newJobId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
