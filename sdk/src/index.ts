/**
 * A typed client for remote-claude's job API.
 *
 * remote-claude is an agent execution substrate: give it a prompt and a
 * repository, get back a diff. This package is how you talk to a deployment of
 * it, so that the next thing built on top does not start by hand-writing fetch
 * calls and re-deriving which field the create response names the id.
 *
 * Layered the same way the executor is, for the same reason:
 *   domain/         what a job is, which statuses are final, what an endpoint is.
 *   application/    the use cases, against a `JobGateway` port.
 *   infrastructure/ that port over HTTP.
 *
 * Deliberately free of any consumer's domain types — no projects, no tasks, no
 * store. It knows about jobs and nothing else. It has no dependencies, and the
 * token is passed per call or held by one gateway object, never in module state.
 */

import { waitForJob, type WaitOptions } from './application/wait-for-job.js';
import type { AuthProbe, SandboxLedger } from './domain/executor.js';
import type { ContinueJob, JobRecord, JobSummary, LogPage, StartJob } from './domain/job.js';
import { HttpJobGateway, type ExecutorConfig } from './infrastructure/http-gateway.js';

export * from './domain/job.js';
export * from './domain/executor.js';
export { normaliseUrl } from './domain/endpoint.js';
export { ExecutorError } from './infrastructure/errors.js';
export { HttpJobGateway, type ExecutorConfig, type HttpJobGatewayOptions } from './infrastructure/http-gateway.js';
export { waitForJob, type WaitOptions } from './application/wait-for-job.js';
export type { JobGateway, Sleep } from './application/ports.js';

/**
 * Everything bound to one deployment.
 *
 * The shape to reach for. The loose functions below exist for callers that hold
 * a config rather than a client, and are the same operations.
 */
export function createClient(config: ExecutorConfig) {
  const gateway = new HttpJobGateway(config);
  return {
    gateway,
    health: () => gateway.ping(),
    checkAuth: () => gateway.checkAuth(),
    startJob: (input: StartJob) => gateway.create(input),
    /** A follow-up turn on a finished job: same branch, same conversation. */
    continueJob: (jobId: string, input: ContinueJob) => gateway.continue(jobId, input),
    getJob: (jobId: string) => gateway.get(jobId),
    listJobs: (limit = 20) => gateway.list(limit),
    cancelJob: (jobId: string) => gateway.cancel(jobId),
    getLogs: (jobId: string, since = 0) => gateway.logs(jobId, since),
    getDiff: (jobId: string) => gateway.getDiff(jobId),
    listSandboxes: () => gateway.sandboxes(),
    /** Poll until the job finishes. Resolves on failure too — read `status`. */
    waitForJob: (jobId: string, options?: WaitOptions) => waitForJob(gateway, jobId, options),
  };
}

export type RemoteClaudeClient = ReturnType<typeof createClient>;

/**
 * Is something answering at this URL?
 *
 * Unauthenticated on the executor's side, so `true` proves the URL and nothing
 * about the token. To check the token, make any authenticated call —
 * `listJobs(config, 1)` is the cheapest.
 */
export function health(url: string): Promise<boolean> {
  return new HttpJobGateway({ url, token: '' }).ping();
}

export function checkAuth(config: ExecutorConfig): Promise<AuthProbe> {
  return new HttpJobGateway(config).checkAuth();
}

/**
 * Queue a job. Returns as soon as it is accepted, before it starts running.
 *
 * A `repo` the deployment will not run against fails here with status 400 and a
 * message naming the repository — not later, and not silently against whichever
 * repository that deployment happens to be pinned to.
 */
export function startJob(config: ExecutorConfig, input: StartJob): Promise<JobRecord> {
  return new HttpJobGateway(config).create(input);
}

/**
 * A follow-up turn on a finished job.
 *
 * For the case a one-shot job cannot handle: the agent stopped to ask something.
 * The turn restores that job's workspace and resumes its conversation, so the
 * answer lands where the question was asked rather than at the start.
 */
export function continueJob(
  config: ExecutorConfig,
  jobId: string,
  input: ContinueJob
): Promise<JobRecord> {
  return new HttpJobGateway(config).continue(jobId, input);
}

export function getJob(config: ExecutorConfig, jobId: string): Promise<JobRecord> {
  return new HttpJobGateway(config).get(jobId);
}

/** Recent jobs, newest first, without each step's captured output. */
export function listJobs(config: ExecutorConfig, limit = 20): Promise<JobSummary[]> {
  return new HttpJobGateway(config).list(limit);
}

export function cancelJob(config: ExecutorConfig, jobId: string): Promise<void> {
  return new HttpJobGateway(config).cancel(jobId);
}

/** One page of logs. Feed `nextSince` back in to continue. */
export function getLogs(config: ExecutorConfig, jobId: string, since = 0): Promise<LogPage> {
  return new HttpJobGateway(config).logs(jobId, since);
}

/** The patch, or null while there is not one. */
export function getDiff(config: ExecutorConfig, jobId: string): Promise<string | null> {
  return new HttpJobGateway(config).getDiff(jobId);
}

/** What that deployment has allocated and whether it got it back. */
export function listSandboxes(config: ExecutorConfig): Promise<SandboxLedger> {
  return new HttpJobGateway(config).sandboxes();
}
