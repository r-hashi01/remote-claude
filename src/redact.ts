/**
 * Secret masking.
 *
 * Every string that can reach persisted logs, the HTTP API or `console.log`
 * MUST pass through a redactor built here. Two layers:
 *
 *   1. Literal match against the concrete secret values bound to the Worker.
 *   2. Pattern match, to catch credentials this Worker never knew about
 *      (for example a token Claude Code printed from a file it read).
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Anthropic
  [/sk-ant-[A-Za-z0-9_\-]{16,}/g, '[redacted:anthropic-key]'],
  [/sk-ant-oat[A-Za-z0-9_\-]{16,}/g, '[redacted:anthropic-oauth]'],
  // GitHub
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted:github-token]'],
  [/github_pat_[A-Za-z0-9_]{40,}/g, '[redacted:github-pat]'],
  // Generic bearer / basic headers
  [/(?<=[Aa]uthorization:\s*[Bb]earer\s+)[\w\-.~+/=]{12,}/g, '[redacted]'],
  [/(?<=[Aa]uthorization:\s*[Bb]asic\s+)[\w\-.~+/=]{12,}/g, '[redacted]'],
  // Credentials embedded in a URL (https://user:pass@host)
  [/(?<=:\/\/)[^/\s:@]+:[^/\s@]+(?=@)/g, '[redacted]'],
  // AWS/R2 style secret access keys
  [/(?<=[Ss]ecret[_-]?[Aa]ccess[_-]?[Kk]ey["'\s:=]{1,4})[A-Za-z0-9/+=]{32,}/g, '[redacted]'],
];

export type Redactor = (input: string) => string;

/**
 * Build a redactor closed over the concrete secret values.
 * Values shorter than 8 characters are ignored - masking those would corrupt
 * unrelated output without meaningfully protecting anything.
 */
export function createRedactor(secrets: Array<string | undefined>): Redactor {
  const literals = secrets
    .filter((s): s is string => typeof s === 'string' && s.length >= 8)
    // Longest first, so a token that contains another token still masks fully.
    .sort((a, b) => b.length - a.length);

  return (input: string): string => {
    if (!input) return input;
    let out = input;
    for (const secret of literals) {
      out = out.split(secret).join('[redacted]');
    }
    for (const [pattern, replacement] of PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  };
}

/** Redactor used before any Worker env is available (e.g. top-level errors). */
export const patternOnlyRedactor: Redactor = createRedactor([]);
