import type { AuthProbe, SandboxLedger } from '../domain/executor.js';
import type { ContinueJob, JobRecord, JobSummary, LogPage, StartJob } from '../domain/job.js';

export type { AuthProbe, SandboxLedger, SandboxLedgerEntry } from '../domain/executor.js';

/**
 * The one thing this package needs from the outside world: something that can
 * answer questions about jobs.
 *
 * Implemented over HTTP in `../infrastructure/http-gateway.ts` and over a Map in
 * `./testing.ts`. The use cases here depend on this and not on `fetch`, which is
 * what makes the polling loop testable — and would make a different transport
 * (a queue, an RPC binding, a mock server) a new file rather than a rewrite.
 */
export interface JobGateway {
  /** Is something answering? Unauthenticated on the executor's side. */
  ping(): Promise<boolean>;
  checkAuth(): Promise<AuthProbe>;
  create(input: StartJob): Promise<JobRecord>;
  /** A follow-up turn on a finished job. */
  continue(jobId: string, input: ContinueJob): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord>;
  list(limit: number): Promise<JobSummary[]>;
  cancel(jobId: string): Promise<void>;
  logs(jobId: string, since: number): Promise<LogPage>;
  /**
   * The patch, or null while there is not one.
   *
   * `git diff <baseBranch>..HEAD` — everything the branch carries, not what the
   * most recent turn added. A continuation runs on the branch it continues, so
   * the second turn's patch contains the first turn's changes as well. There is
   * no way to ask for one turn's increment; take the difference yourself if you
   * need it.
   *
   * The range has two dots, and the left side is the base branch **as the
   * sandbox cloned it** — frozen at the first turn, since a continuation
   * restores that workspace rather than re-cloning. Commits that land on the
   * real base branch between turns do not move it and do not show up here.
   */
  getDiff(jobId: string): Promise<string | null>;
  sandboxes(): Promise<SandboxLedger>;
}

/** Waiting, as a dependency — so tests do not have to. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
