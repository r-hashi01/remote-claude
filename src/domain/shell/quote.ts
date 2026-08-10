/**
 * Everything that reaches a shell in the container goes through here.
 *
 * What used to live in this module — the whole job pipeline — moved into
 * container/runner.mjs (ADR 0004). Only the quoting rule remains, which is a
 * domain concern precisely because forgetting it is how a branch name becomes a
 * command.
 */

/** Wrap a value as a single-quoted POSIX shell argument. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
