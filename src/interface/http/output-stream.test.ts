import { describe, expect, test } from 'vitest';
import type { JobStatus } from '../../domain/job/record';
import { BACKFILL_BYTES, streamOutput, type OutputSource } from './output-stream';

/**
 * The stream, read the way a client reads it.
 *
 * Everything here is decided by this file — where a late reader starts, when the
 * end is announced, what a dropped connection can be told apart from — so it is
 * tested without a runtime, against a source that answers whatever a case needs.
 */
function source(
  windows: Array<{ text: string; done?: boolean; size?: number }>,
  status: JobStatus = 'completed'
): OutputSource & { reads: number[] } {
  const reads: number[] = [];
  let index = 0;
  return {
    reads,
    async readOutput(_jobId, offset, limit) {
      // The size probe: limit 0 is how the stream asks where the file ends.
      if (limit === 0) return { text: '', nextOffset: offset, size: windows[0]?.size ?? 0, done: false };
      reads.push(offset);
      const window = windows[Math.min(index++, windows.length - 1)] as {
        text: string;
        done?: boolean;
      };
      return {
        text: window.text,
        nextOffset: offset + window.text.length,
        size: offset + window.text.length,
        done: window.done ?? false,
      };
    },
    async status() {
      return status;
    },
  };
}

/** The events in order, as a client's `onmessage` would see them. */
async function eventsOf(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const body = await response.text();
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = /event: (.+)/.exec(block)?.[1] as string;
      const data = /data: (.+)/.exec(block)?.[1] as string;
      return { event, data: JSON.parse(data) };
    });
}

const noSleep = async (): Promise<void> => {};

describe('streaming a job\'s output', () => {
  test('is an event stream, unbuffered', () => {
    const response = streamOutput(source([{ text: '', done: true }]), 'job-1', { sleep: noSleep });

    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
  });

  test('sends output as it appears, with the offset to resume from', async () => {
    const response = streamOutput(
      source([{ text: '▶ install\n' }, { text: 'added 101 packages\n' }, { text: '', done: true }]),
      'job-1',
      { offset: 0, sleep: noSleep }
    );

    expect(await eventsOf(response)).toEqual([
      { event: 'start', data: { offset: 0, skipped: 0 } },
      { event: 'chunk', data: { offset: 10, text: '▶ install\n' } },
      { event: 'chunk', data: { offset: 29, text: 'added 101 packages\n' } },
      { event: 'end', data: { status: 'completed', offset: 29 } },
    ]);
  });

  // R5. A finished run and a dropped connection look identical without this, and
  // the client is left to guess — the same class of bug as work thrown away
  // because nothing said the run had stopped.
  test('says the job ended, and with what status', async () => {
    const response = streamOutput(source([{ text: '', done: true }], 'failed'), 'job-1', {
      offset: 0,
      sleep: noSleep,
    });

    const events = await eventsOf(response);
    expect(events.at(-1)).toEqual({ event: 'end', data: { status: 'failed', offset: 0 } });
  });

  // The withheld tail is released on the last read, so ending as soon as the job
  // is terminal would drop the final bytes of every single run.
  test('does not end until the last window has been read', async () => {
    const response = streamOutput(
      source([{ text: 'the last line\n', done: true }, { text: '', done: true }]),
      'job-1',
      { offset: 0, sleep: noSleep }
    );

    const events = await eventsOf(response);
    expect(events.map((entry) => entry.event)).toEqual(['start', 'chunk', 'end']);
    expect(events[1]?.data).toMatchObject({ text: 'the last line\n' });
  });

  // R3. A reader who arrives at minute nine should see that they arrived late,
  // not a run that appears to have started then.
  test('starts a late reader near the end, and says how much it skipped', async () => {
    const response = streamOutput(
      source([{ text: '', done: true, size: BACKFILL_BYTES * 3 }]),
      'job-1',
      { sleep: noSleep }
    );

    const [start] = await eventsOf(response);
    expect(start).toEqual({
      event: 'start',
      data: { offset: BACKFILL_BYTES * 2, skipped: BACKFILL_BYTES * 2 },
    });
  });

  test('resumes exactly where a dropped connection stopped', async () => {
    const backing = source([{ text: 'more\n' }, { text: '', done: true }]);
    const response = streamOutput(backing, 'job-1', { offset: 4_096, sleep: noSleep });

    const [start] = await eventsOf(response);
    expect(start).toEqual({ event: 'start', data: { offset: 4_096, skipped: 0 } });
    expect(backing.reads[0]).toBe(4_096);
  });

  // Something has to arrive while a step is quiet, or a stream that is working and
  // one that is wedged are the same picture.
  test('says it is idle rather than saying nothing', async () => {
    let closed = false;
    const controller = new AbortController();
    const backing: OutputSource = {
      async readOutput(_jobId, offset) {
        if (closed) return { text: '', nextOffset: offset, size: offset, done: true };
        closed = true;
        return { text: '', nextOffset: offset, size: offset, done: false };
      },
      async status() {
        return 'running';
      },
    };

    const response = streamOutput(backing, 'job-1', {
      offset: 0,
      sleep: noSleep,
      signal: controller.signal,
    });

    const events = await eventsOf(response);
    expect(events.map((entry) => entry.event)).toEqual(['start', 'idle', 'end']);
  });

  test('stops when the reader goes away', async () => {
    const controller = new AbortController();
    controller.abort();

    const response = streamOutput(source([{ text: 'never sent\n' }]), 'job-1', {
      offset: 0,
      sleep: noSleep,
      signal: controller.signal,
    });

    expect((await eventsOf(response)).map((entry) => entry.event)).toEqual(['start']);
  });

  test('reports a failure to read rather than closing silently', async () => {
    const broken: OutputSource = {
      async readOutput() {
        throw new Error('sandbox is gone');
      },
      async status() {
        return 'running';
      },
    };

    const events = await eventsOf(streamOutput(broken, 'job-1', { offset: 0, sleep: noSleep }));
    expect(events.at(-1)).toEqual({ event: 'error', data: { message: 'sandbox is gone' } });
  });
});
