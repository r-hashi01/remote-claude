import { isTerminal, type JobRecord, type JobStatus, type LogLine } from '../domain/job.js';
import type { JobGateway, Sleep } from './ports.js';

export interface WaitOptions {
  /** How often to ask. Defaults to two seconds, the executor's own poll. */
  intervalMs?: number;
  /** Called with each new batch of log lines, in order, as they appear. */
  onLog?: (lines: LogLine[]) => void;
  /** Called whenever the status changes, including the first one observed. */
  onStatus?: (status: JobStatus, job: JobRecord) => void;
  /** Stop waiting. The job keeps running — use `cancelJob` to stop that too. */
  signal?: AbortSignal;
  /** Injectable for tests; the default is a real timer. */
  sleep?: Sleep;
}

/**
 * Poll until the job reaches a terminal state, and return it.
 *
 * Polling rather than streaming because that is what the API offers, and every
 * consumer was writing this loop — including the parts that are easy to get
 * subtly wrong: advancing the log cursor only when a page had lines, reading the
 * tail once more after the status turns terminal, and not reporting the same
 * status twice.
 *
 * Resolves on `failed` and `cancelled` as well: those are outcomes, not
 * exceptions. Read `job.status` and `job.error`.
 */
export async function waitForJob(
  gateway: JobGateway,
  jobId: string,
  options: WaitOptions = {}
): Promise<JobRecord> {
  const { intervalMs = 2_000, onLog, onStatus, signal, sleep = realSleep } = options;

  let since = 0;
  let reported: JobStatus | undefined;

  const drainLogs = async (): Promise<void> => {
    if (!onLog) return;
    const page = await gateway.logs(jobId, since);
    if (page.logs.length === 0) return;
    since = page.nextSince;
    onLog(page.logs);
  };

  for (;;) {
    throwIfAborted(signal);

    const job = await gateway.get(jobId);
    await drainLogs();

    if (job.status !== reported) {
      reported = job.status;
      onStatus?.(job.status, job);
    }

    if (isTerminal(job.status)) {
      // The executor mirrors the container's last lines as it settles, so the
      // tail arrives just after the status does.
      await drainLogs();
      return job;
    }

    await sleep(intervalMs, signal);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('waiting was aborted');
}

const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('waiting was aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
