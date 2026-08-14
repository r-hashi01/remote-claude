import type { ExecutorConfig } from '../infrastructure/http-gateway.js';
import { normaliseUrl } from '../domain/endpoint.js';
import type { JobStatus } from '../domain/job.js';

export interface FollowOptions {
  /**
   * Where to resume from. Omit to let the executor choose — it starts a late
   * reader near the end and says how much it skipped.
   *
   * Use the offset from the last chunk you were given, not one you counted
   * yourself: the executor withholds a tail while more can arrive, so the offset
   * it reports is what you have been *shown*.
   */
  offset?: number;
  /** Output, in order, with the offset to resume from if the connection drops. */
  onChunk?: (text: string, offset: number) => void;
  /** Where this stream began, and how many bytes it skipped to get there. */
  onStart?: (offset: number, skipped: number) => void;
  /** Nothing new. Proof the stream is alive rather than wedged. */
  onIdle?: (offset: number) => void;
  /** Stop following. The job keeps running. */
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Follow a job's output until it ends, and say how it ended.
 *
 * `getLogs` answers where a run is up to — parsed lines, with the step markers
 * and which stream each came from. This answers what is happening: the bytes the
 * commands produced, arriving as they are produced.
 *
 * Resolves when the job finishes, with its status. It rejects only if the stream
 * itself failed; a job that failed is an outcome, and comes back as one.
 */
export async function followOutput(
  config: ExecutorConfig,
  jobId: string,
  options: FollowOptions = {}
): Promise<{ status: JobStatus; offset: number }> {
  const base = normaliseUrl(config.url);
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const query = options.offset === undefined ? '' : `?offset=${options.offset}`;

  const response = await fetchImpl(`${base}/jobs/${jobId}/output/stream${query}`, {
    headers: { authorization: `Bearer ${config.token}`, accept: 'text/event-stream' },
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`GET /jobs/${jobId}/output/stream failed (${response.status}): ${detail}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  // Events arrive split wherever the network split them, so the boundary is
  // found here rather than assumed to be a chunk edge.
  let pending = '';
  let ending: { status: JobStatus; offset: number } | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) pending += value;

      let boundary = pending.indexOf('\n\n');
      while (boundary !== -1) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        ending = handle(block, options) ?? ending;
        if (ending) return ending;
        boundary = pending.indexOf('\n\n');
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (ending) return ending;
  throw new Error(`the output stream for job ${jobId} ended without saying the job had`);
}

/** One event. Returns the ending when this was one. */
function handle(
  block: string,
  options: FollowOptions
): { status: JobStatus; offset: number } | null {
  const event = /event: (.+)/.exec(block)?.[1];
  const raw = /data: (.+)/.exec(block)?.[1];
  if (!event || !raw) return null;

  const data = JSON.parse(raw) as Record<string, never>;
  switch (event) {
    case 'start':
      options.onStart?.(Number(data.offset), Number(data.skipped));
      return null;
    case 'chunk':
      options.onChunk?.(String(data.text), Number(data.offset));
      return null;
    case 'idle':
      options.onIdle?.(Number(data.offset));
      return null;
    case 'end':
      return { status: data.status as unknown as JobStatus, offset: Number(data.offset) };
    case 'error':
      throw new Error(String(data.message));
    default:
      return null;
  }
}
