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

  const clean = redact(chunk);
  if (final) return { text: clean, nextOffset: offset + chunk.length };

  // Withheld against the raw length, not the redacted one: the offset counts
  // bytes of the file, and masking changes the text's length but not the file's.
  if (chunk.length <= HOLD_BACK_BYTES) return { text: '', nextOffset: offset };

  const emitted = redact(chunk.slice(0, -HOLD_BACK_BYTES));
  return { text: emitted, nextOffset: offset + chunk.length - HOLD_BACK_BYTES };
}
