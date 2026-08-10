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
  /**
   * How many polls in a row may fail transiently before giving up. Defaults to
   * five, which at the default interval is ten seconds of an unreachable
   * executor.
   */
  maxConsecutiveErrors?: number;
  /** Called when a poll failed in a way worth retrying. */
  onTransientError?: (error: TransientError, consecutive: number) => void;
  /** Injectable for tests; the default is a real timer. */
  sleep?: Sleep;
}

/** An error carrying an HTTP status, when it had one. */
export interface TransientError extends Error {
  status?: number;
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
  const {
    intervalMs = 2_000,
    onLog,
    onStatus,
    signal,
    sleep = realSleep,
    maxConsecutiveErrors = 5,
    onTransientError,
  } = options;

  let since = 0;
  let reported: JobStatus | undefined;
  let consecutiveErrors = 0;

  const drainLogs = async (): Promise<void> => {
    if (!onLog) return;
    // Logs are reporting on the job. A failure here must never decide whether
    // the caller gets to see the job finish — the executor applies the same rule
    // to its own log mirroring.
    let page;
    try {
      page = await gateway.logs(jobId, since);
    } catch (error) {
      if (!isTransient(error, signal)) throw error;
      onTransientError?.(error as TransientError, consecutiveErrors);
      return;
    }
    if (page.logs.length === 0) return;
    since = page.nextSince;
    onLog(page.logs);
  };

  for (;;) {
    throwIfAborted(signal);

    let job: JobRecord;
    try {
      job = await gateway.get(jobId);
      consecutiveErrors = 0;
    } catch (error) {
      // A deploy resets the executor's coordinator mid-job — the job itself
      // survives, because it runs in a container. Dying here would report a
      // healthy job as a failure.
      if (!isTransient(error, signal)) throw error;
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxConsecutiveErrors) throw error;
      onTransientError?.(error as TransientError, consecutiveErrors);
      await sleep(intervalMs, signal);
      continue;
    }

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

/**
 * Is this worth asking again?
 *
 * Server-side and transport failures are: the executor is restarting, busy, or
 * briefly unreachable, and the job it is watching is unaffected. A 4xx is not —
 * a rejected token or an unknown job will answer the same way forever. A rate
 * limit is the one 4xx that will pass.
 */
function isTransient(error: unknown, signal?: AbortSignal): boolean {
  // An aborted fetch also arrives without a status; the caller asked for that.
  if (signal?.aborted) return false;
  const status = (error as TransientError | undefined)?.status;
  if (status === undefined) return true;
  return status >= 500 || status === 429;
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
