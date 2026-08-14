import { describe, expect, test } from 'vitest';
import { createRedactor } from './redactor';
import { HOLD_BACK_BYTES } from './stream';
import { redactWindow } from './window';

/**
 * The same problem as a stream, answered without holding any state.
 *
 * A reader of a growing file arrives with an offset and leaves with the next one,
 * and there is nothing in between to remember a half-seen secret in. So the
 * hold-back becomes an offset decision instead: emit what is safe, and report a
 * next offset that does not include what was withheld. The reader comes back for
 * it, by which time the rest has arrived.
 */
describe('redacting a window of a growing file', () => {
  const secret = 'hunter2-hunter2-hunter2';
  const redact = createRedactor([secret]);

  test('emits everything when nothing more is coming', () => {
    const window = redactWindow(`all done ${secret}\n`, { redact, final: true, offset: 0 });

    expect(window.text).toBe('all done [redacted]\n');
    expect(window.nextOffset).toBe(`all done ${secret}\n`.length);
  });

  // The case that matters: the window ends mid-secret. Emitting up to the edge
  // would put half a credential on the wire, and no later read could take it back.
  test('withholds a tail that a secret could still straddle', () => {
    const body = `x`.repeat(1_000);
    const window = redactWindow(body, { redact, final: false, offset: 500 });

    expect(window.text).toBe(body.slice(0, -HOLD_BACK_BYTES));
    // The next read starts where this one stopped emitting, not where it stopped
    // reading — which is the whole trick.
    expect(window.nextOffset).toBe(500 + body.length - HOLD_BACK_BYTES);
  });

  test('emits nothing rather than a fragment when the window is short', () => {
    const window = redactWindow('short', { redact, final: false, offset: 40 });

    expect(window.text).toBe('');
    expect(window.nextOffset).toBe(40);
  });

  test('a secret split by the window edge is masked on the read that completes it', () => {
    const body = `token=${secret}`;
    const first = redactWindow(body.slice(0, 15), { redact, final: false, offset: 0 });
    expect(first.text).toBe('');

    const second = redactWindow(body.slice(first.nextOffset), {
      redact,
      final: true,
      offset: first.nextOffset,
    });

    expect(first.text + second.text).toBe('token=[redacted]');
  });

  test('an empty window asks again from where it was', () => {
    const window = redactWindow('', { redact, final: false, offset: 128 });
    expect(window).toEqual({ text: '', nextOffset: 128 });
  });
});
