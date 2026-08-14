import { describe, expect, test, vi } from 'vitest';
import { followOutput } from './follow-output.js';

/**
 * Reading the stream, as a consumer will.
 *
 * The point of this being in the package is that nobody should hand-write the
 * parsing of an event stream to answer "what is this run doing" — which is the
 * same reason the package exists at all.
 */
function streaming(body: string): typeof fetch {
  return vi.fn(async () =>
    new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  ) as unknown as typeof fetch;
}

const events = [
  'event: start\ndata: {"offset":0,"skipped":0}\n\n',
  'event: chunk\ndata: {"offset":10,"text":"▶ install\\n"}\n\n',
  'event: idle\ndata: {"offset":10}\n\n',
  'event: chunk\ndata: {"offset":29,"text":"added 101 packages\\n"}\n\n',
  'event: end\ndata: {"status":"completed","offset":29}\n\n',
].join('');

describe('following a job\'s output', () => {
  test('hands over the text in order and reports the ending', async () => {
    const chunks: string[] = [];
    const outcome = await followOutput(
      { url: 'https://executor.example', token: 't' },
      'job-1',
      { onChunk: (text) => chunks.push(text), fetchImpl: streaming(events) }
    );

    expect(chunks).toEqual(['▶ install\n', 'added 101 packages\n']);
    expect(outcome).toEqual({ status: 'completed', offset: 29 });
  });

  // What a reconnection needs. The offset a caller holds must be one the executor
  // will accept as a resume point, which is the offset of what they were *shown*.
  test('reports the offset with each chunk, for resuming', async () => {
    const offsets: number[] = [];
    await followOutput(
      { url: 'https://executor.example', token: 't' },
      'job-1',
      { onChunk: (_text, offset) => offsets.push(offset), fetchImpl: streaming(events) }
    );

    expect(offsets).toEqual([10, 29]);
  });

  test('says when it started late, and by how much', async () => {
    const started: unknown[] = [];
    await followOutput({ url: 'https://executor.example', token: 't' }, 'job-1', {
      onStart: (offset, skipped) => started.push({ offset, skipped }),
      fetchImpl: streaming('event: start\ndata: {"offset":4096,"skipped":4096}\n\nevent: end\ndata: {"status":"completed","offset":4096}\n\n'),
    });

    expect(started).toEqual([{ offset: 4096, skipped: 4096 }]);
  });

  // An event split across two network chunks is the normal case, not the odd one.
  test('reassembles an event that arrived in pieces', async () => {
    const chunks: string[] = [];
    const halves = ['event: chunk\ndata: {"offset":5,"te', 'xt":"hello"}\n\nevent: end\ndata: {"status":"completed","offset":5}\n\n'];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              for (const half of halves) controller.enqueue(encoder.encode(half));
              controller.close();
            },
          })
        )
    ) as unknown as typeof fetch;

    await followOutput({ url: 'https://executor.example', token: 't' }, 'job-1', {
      onChunk: (text) => chunks.push(text),
      fetchImpl,
    });

    expect(chunks).toEqual(['hello']);
  });

  test('carries the bearer token and the offset asked for', async () => {
    const fetchImpl = vi.fn(async () => new Response('event: end\ndata: {"status":"completed","offset":7}\n\n')) as unknown as typeof fetch;

    await followOutput({ url: 'https://executor.example', token: 'secret' }, 'job-1', {
      offset: 7,
      fetchImpl,
    });

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('https://executor.example/jobs/job-1/output/stream?offset=7');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
  });

  test('surfaces an error event as a rejection', async () => {
    await expect(
      followOutput({ url: 'https://executor.example', token: 't' }, 'job-1', {
        fetchImpl: streaming('event: error\ndata: {"message":"sandbox is gone"}\n\n'),
      })
    ).rejects.toThrow(/sandbox is gone/);
  });
});
