import type { Redactor } from './redactor';

/**
 * How much of the tail to hold back between chunks.
 *
 * A secret only has to be *longer* than this for a split to slip past, so it is
 * set above the longest credential this system deals with: an Anthropic OAuth
 * token, a GitHub PAT, an R2 secret access key. Generous on purpose — the cost
 * of holding back is latency measured in one chunk, and the cost of getting it
 * wrong is a credential in somebody's browser.
 */
export const HOLD_BACK_BYTES = 256;

export interface StreamRedactor {
  /** Redact what can be decided now; keep back what a secret could still span. */
  push(chunk: string): string;
  /** No more is coming, so release the tail. */
  end(): string;
}

/**
 * Redaction for output that arrives in pieces.
 *
 * The line-based path never needed this: a line arrives whole, and a secret in
 * it is either there or not. A byte stream has no such promise — the boundary
 * falls wherever the pipe put it, and a token split across two chunks matches
 * neither half. Nothing later can repair it, because every chunk emitted has
 * already been sent.
 *
 * So the last `HOLD_BACK_BYTES` are not emitted until either more arrives or the
 * stream ends. The buffer is redacted whole each time, which means a match is
 * found wherever it fell — at the cost of re-scanning a small window, which is
 * the same work the line path does per line.
 */
export function createStreamRedactor(redact: Redactor): StreamRedactor {
  let held = '';

  return {
    push(chunk: string): string {
      const clean = redact(held + chunk);
      if (clean.length <= HOLD_BACK_BYTES) {
        held = clean;
        return '';
      }
      held = clean.slice(-HOLD_BACK_BYTES);
      return clean.slice(0, -HOLD_BACK_BYTES);
    },

    end(): string {
      const rest = redact(held);
      held = '';
      return rest;
    },
  };
}
