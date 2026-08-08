/**
 * Small shared helpers.
 *
 * What used to live here — the whole job pipeline — moved into
 * container/runner.mjs (ADR 0004). Keeping the module around as a shell of its
 * former self would invite someone to add pipeline logic back on this side, so
 * only the genuinely shared pieces remain, under an honest name.
 */

/** Hard cap on an accepted prompt. */
export const MAX_PROMPT_LENGTH = 20_000;

/** Wrap a value as a single-quoted POSIX shell argument. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
