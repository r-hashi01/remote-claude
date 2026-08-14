import type { JobStatus } from '../../domain/job/record';

/** What the endpoint needs from the executor, and nothing more. */
export interface OutputSource {
  readOutput(
    jobId: string,
    offset: number,
    limit: number,
  ): Promise<{ text: string; nextOffset: number; size: number; done: boolean }>;
  status(jobId: string): Promise<JobStatus | null>;
}

/** How much of what already happened a reader gets when they arrive late. */
export const BACKFILL_BYTES = 64 * 1024;

/** Bytes per read. Small enough to arrive promptly, large enough to keep up. */
const WINDOW_BYTES = 64 * 1024;

/** How long between reads while nothing new is arriving. */
const IDLE_MS = 400;

/**
 * A job's output, as it is produced, over Server-Sent Events.
 *
 * The polling is on this side of the wire. The executor reads a window of the
 * file and answers; nothing is held open in the Durable Object, which has a job
 * to run and should not be occupied by somebody watching it. What the reader gets
 * is a connection that stays open and events that arrive as the run produces
 * them, which is the thing that was missing: a page could show a run's lines,
 * two seconds at a time, and not show it happening.
 *
 * Four events:
 *   start  — where this stream begins, and how much was skipped to get there
 *   chunk  — output, with the offset to resume from if this connection drops
 *   idle   — nothing new; proof the stream is alive rather than wedged
 *   end    — the job finished, with its status. Distinguishable from a drop,
 *            which is what a client cannot otherwise tell.
 */
export function streamOutput(
  source: OutputSource,
  jobId: string,
  options: { offset?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> },
): Response {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        let offset = options.offset ?? -1;

        // Arriving with no offset means "from the beginning of what matters".
        // Bounded, and the boundary is stated rather than quietly dropped: a
        // reader who joins at minute nine should not be shown a run that appears
        // to have started at minute nine, nor handed nine minutes of npm output.
        if (offset < 0) {
          const { size } = await source.readOutput(jobId, 0, 0);
          offset = Math.max(0, size - BACKFILL_BYTES);
          send('start', { offset, skipped: offset });
        } else {
          send('start', { offset, skipped: 0 });
        }

        for (;;) {
          if (options.signal?.aborted) break;

          const window = await source.readOutput(jobId, offset, WINDOW_BYTES);
          if (window.text) {
            offset = window.nextOffset;
            send('chunk', { offset, text: window.text });
          }

          // Only when the job is over *and* it has been read to the end: the last
          // window is where the withheld tail is finally released, and ending
          // before it would drop the final bytes of every run.
          if (window.done && !window.text) {
            send('end', { status: (await source.status(jobId)) ?? 'completed', offset });
            break;
          }

          if (!window.text) {
            send('idle', { offset });
            await sleep(IDLE_MS);
          }
        }
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      // Nothing here should be buffered by anything between: the point is arrival
      // time, and a proxy holding a chunk back defeats the whole endpoint.
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
