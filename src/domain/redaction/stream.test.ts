import { describe, expect, test } from 'vitest';
import { createRedactor } from './redactor';
import { createStreamRedactor, HOLD_BACK_BYTES } from './stream';

/**
 * Redaction that has to survive being handed the text in pieces.
 *
 * The line-based path never had this problem: a line arrives whole, and a secret
 * inside it is either there or not. A byte stream has no such promise — the
 * chunk boundary falls wherever the network put it, and a token split across two
 * chunks matches neither half. Every chunk emitted is emitted for good, so this
 * is not a case that can be fixed on the next pass.
 */
describe('redacting a stream', () => {
  const secret = 'hunter2-hunter2-hunter2';
  const redact = createRedactor([secret]);

  test('masks a secret that arrives whole', () => {
    const stream = createStreamRedactor(redact);
    expect(stream.push(`token=${secret}\n`) + stream.end()).toBe('token=[redacted]\n');
  });

  test('masks one split across a chunk boundary', () => {
    const stream = createStreamRedactor(redact);
    const half = Math.floor(secret.length / 2);

    const emitted =
      stream.push(`token=${secret.slice(0, half)}`) +
      stream.push(`${secret.slice(half)}\nnext line\n`) +
      stream.end();

    expect(emitted).toBe('token=[redacted]\nnext line\n');
    expect(emitted).not.toContain('hunter2');
  });

  test('masks one split a byte at a time', () => {
    const stream = createStreamRedactor(redact);
    let emitted = '';
    for (const character of `before ${secret} after`) emitted += stream.push(character);
    emitted += stream.end();

    expect(emitted).toBe('before [redacted] after');
  });

  // The price of the guarantee: the last few bytes wait for the next chunk, or
  // for the end. A reader must be told which bytes it now holds, not assume the
  // stream is at the offset it last sent.
  test('holds back only what a secret could still straddle', () => {
    const stream = createStreamRedactor(redact);
    const long = 'x'.repeat(HOLD_BACK_BYTES * 3);

    const emitted = stream.push(long);

    expect(emitted.length).toBe(long.length - HOLD_BACK_BYTES);
    expect(emitted + stream.end()).toBe(long);
  });

  test('gives everything back when the stream ends', () => {
    const stream = createStreamRedactor(redact);
    const tail = 'a short tail';
    expect(stream.push(tail)).toBe('');
    expect(stream.end()).toBe(tail);
  });

  // Pattern matches too: this is the layer that catches a credential nobody
  // configured, and it fails the same way at a boundary.
  test('masks a pattern split across chunks', () => {
    const stream = createStreamRedactor(createRedactor([]));
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

    const emitted = stream.push(`saw ${token.slice(0, 10)}`) + stream.push(`${token.slice(10)} done`) + stream.end();

    expect(emitted).toBe('saw [redacted:github-token] done');
  });

  test('passes ordinary output through unchanged', () => {
    const stream = createStreamRedactor(redact);
    const text = 'added 101 packages in 23s\n';
    expect(stream.push(text) + stream.end()).toBe(text);
  });
});
