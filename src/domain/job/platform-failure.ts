/**
 * What the platform said, read rather than rewritten.
 *
 * The sandbox SDK raises errors that already carry everything worth knowing: a
 * machine-readable `code`, a `context` whose fields differ by failure kind, the
 * `operation`, and often a `suggestion` and a documentation link. Every one of those
 * was being discarded — the layers above matched the message with a regular
 * expression, and the job's record kept the message alone. A container start failed
 * and cost a day to investigate for want of one word.
 *
 * The first attempt at fixing that copied the fields into a class of this
 * repository's own and threw that instead. Wrong: whatever is not copied is gone,
 * and what is left is this repository's account of the failure rather than the
 * platform's. **The error is not converted.** It travels as the SDK raised it, and
 * these functions read it where it is caught — in the same isolate, so nothing has
 * crossed a boundary that would strip it.
 *
 * Read structurally rather than by import, because the domain imports nothing
 * (ADR 0008): any error carrying `toJSON` with a `code` and a `context` is one of
 * theirs, including kinds this file has never heard of.
 */

/** The SDK's own report, verbatim. Field names and values are theirs. */
export interface PlatformReport {
  code?: unknown;
  context?: Record<string, unknown>;
  operation?: unknown;
  httpStatus?: unknown;
  suggestion?: unknown;
  documentation?: unknown;
  timestamp?: unknown;
  name?: unknown;
  message?: unknown;
}

/**
 * The platform's report, if the thrown thing is one of theirs.
 *
 * Duck-typed on purpose. A new error class in the SDK carries new context and is
 * read by this without changing, which is the opposite of the mapping table this
 * replaced — that would have needed a case per class and would have silently
 * flattened anything unlisted.
 */
export function platformReport(error: unknown): PlatformReport | null {
  // Through wrappers, because some paths add a message worth having. The clone path
  // does: git's own error names a URL and a credential and says nothing about which
  // of the two plausible causes it is, so the wrapper names both. That wrapping was
  // replacing the platform's error rather than carrying it, and `code=` reached the
  // log for every failure except the one that path produced.
  const seen = new Set<unknown>();
  let candidate: unknown = error;

  while (typeof candidate === 'object' && candidate !== null && !seen.has(candidate)) {
    seen.add(candidate);

    const report = readReport(candidate);
    if (report) return report;

    candidate = (candidate as { cause?: unknown }).cause;
  }

  return null;
}

/** One error's report, if it has one. */
function readReport(error: object): PlatformReport | null {
  const candidate = error as { toJSON?: unknown };
  if (typeof candidate.toJSON !== 'function') return null;

  const report = (candidate.toJSON as () => unknown)();
  if (typeof report !== 'object' || report === null) return null;
  if (!('code' in report) || !('context' in report)) return null;

  // `stack` is dropped and nothing else is: it is long, it is already on the error,
  // and it is the one field a reader of a log does not want inline.
  const { stack: _stack, ...rest } = report as Record<string, unknown>;
  return rest as PlatformReport;
}

/**
 * The platform's report as a line, in the platform's words.
 *
 * Not a sentence about the failure — those were written here once and read as
 * "not retryable" where the platform had said `retryable: false`, and "nothing had
 * run yet" where it had said `admitted: false`. A gloss is a second thing to trust.
 * This prints the fields as they came, so what a reader sees is what the SDK said.
 *
 * Empty when the thrown thing was not the platform's, so a caller can append it
 * unconditionally.
 */
export function describePlatformReport(report: PlatformReport | null): string {
  if (!report) return '';

  const parts = [`code=${String(report.code)}`];
  if (report.operation !== undefined) parts.push(`operation=${String(report.operation)}`);
  if (report.httpStatus !== undefined) parts.push(`httpStatus=${String(report.httpStatus)}`);
  if (report.context && Object.keys(report.context).length > 0) {
    parts.push(`context=${JSON.stringify(report.context)}`);
  }
  if (report.suggestion !== undefined) parts.push(`suggestion=${String(report.suggestion)}`);
  if (report.documentation !== undefined) {
    parts.push(`documentation=${String(report.documentation)}`);
  }
  return parts.join(' ');
}

/** What `context` says about retrying, when it says. */
export function reportedRetryable(report: PlatformReport | null): boolean | undefined {
  const value = report?.context?.['retryable'];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * What `context` says about whether the operation's effects landed.
 *
 * `true`, `false`, or the string `'unknown'` — the SDK's three answers, passed
 * through rather than collapsed. It is the question ADR 0006 had to guess at.
 */
export function reportedAdmitted(
  report: PlatformReport | null,
): boolean | 'unknown' | undefined {
  const value = report?.context?.['admitted'];
  if (typeof value === 'boolean') return value;
  return value === 'unknown' ? 'unknown' : undefined;
}
