import type { Redactor } from './redactor';
import { HOLD_BACK_BYTES } from './stream';

export interface WindowOptions {
  redact: Redactor;
  /** Whether anything more can arrive. At the end, the tail is safe to release. */
  final: boolean;
  /** Where this window was read from, so the answer can say where to resume. */
  offset: number;
}

/**
 * Redact a window of a file that is still being written, and say where to resume.
 *
 * A stream can hold a partial secret in memory between chunks. A reader of a
 * growing file cannot: it arrives with an offset, leaves with the next one, and
 * nothing in between remembers anything. So the hold-back becomes an offset
 * decision — emit what is safe, and report a next offset that excludes what was
 * withheld, so the reader collects it once the rest has arrived.
 *
 * Which means the offset a reader is given is *what it has been shown*, never
 * what the server managed to read. Those differ by design.
 */
export function redactWindow(
  chunk: string,
  { redact, final, offset }: WindowOptions,
): { text: string; nextOffset: number } {
  if (chunk === '') return { text: '', nextOffset: offset };

  if (final) return { text: redact(chunk), nextOffset: offset + byteLength(chunk) };

  // Withheld against what was read, not what will be shown: masking changes the
  // text's length and cannot change the file's.
  const shown = withoutTail(chunk);
  if (shown === '') return { text: '', nextOffset: offset };

  return { text: redact(shown), nextOffset: offset + byteLength(shown) };
}

/**
 * Bytes, because that is what an offset into a file counts.
 *
 * The distinction is not pedantic: it cost a duplicated credential-shaped line in
 * the first run ever watched. `▶`, `✔` and `—` are one character and three bytes
 * each, so a window's length in characters ran behind its length in bytes, the
 * next read began inside what had already been sent, and the overlap arrived as
 * text repeated mid-word.
 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Everything except the last HOLD_BACK_BYTES bytes, cut on a character. */
function withoutTail(chunk: string): string {
  let kept = chunk.length;
  // Walk back by characters until the withheld part is at least the hold-back, so
  // the cut never falls inside one — a half-character would arrive as a
  // replacement glyph and the offset would still have to skip its other bytes.
  while (kept > 0 && byteLength(chunk.slice(kept)) < HOLD_BACK_BYTES) kept -= 1;
  return chunk.slice(0, kept);
}
