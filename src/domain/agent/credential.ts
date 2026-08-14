/**
 * Which credential this deployment authenticates Claude Code with.
 *
 * Two are possible and they are not interchangeable:
 *
 * - `subscription` — the long-lived OAuth token from `claude setup-token`, which
 *   bills a Claude Free/Pro/Max/Team/Enterprise plan. Only the person who bought
 *   the plan may run it (ADR 0013).
 * - `api-key` — a key from the Claude Console, which bills an API account at
 *   pay-as-you-go rates. This is the credential Anthropic's terms point
 *   developers at, and the one that survives being used by something other than
 *   a person at a keyboard.
 *
 * The scheme is *derived from which credential is configured* rather than
 * selected by a flag, for the reason the workspace bucket has no flag either: a
 * flag and a credential can disagree, and the failure that follows is a request
 * signed with the wrong thing — which reads as "Claude is broken" rather than as
 * a configuration mistake.
 *
 * Neither configured, or both, is a `problem` rather than a default. Both is the
 * interesting one: something has to decide which account pays, and no reading of
 * two secrets tells you which one the deployer meant. Picking the cheaper, the
 * first, or the newer would all be a guess about somebody's money.
 */
export type ClaudeAuthScheme = 'subscription' | 'api-key';

/**
 * What stands in for the credential inside the container in proxy mode.
 *
 * Claude Code needs *a* value to decide which scheme to use and to put on the
 * wire; the Worker's outbound handler replaces it with the real one on the way
 * out, so this is the only credential-shaped string the container ever holds
 * (ADR 0002).
 */
export const PROXY_SENTINEL = 'proxy-injected';

/** The secrets a deployment holds, as far as this decision is concerned. */
export interface ConfiguredCredentials {
  /** `CLAUDE_CODE_OAUTH_TOKEN`. */
  oauthToken?: string;
  /** `ANTHROPIC_API_KEY`. */
  apiKey?: string;
}

export interface ClaudeCredential {
  scheme: ClaudeAuthScheme;
  /**
   * Why no request to Anthropic will succeed, when that is the case.
   *
   * `scheme` is still populated so that a command line can be built — the
   * decision of which variables to unset has to be made either way — but a
   * caller that is about to *send* something must report this instead.
   */
  problem?: string;
}

const NO_CREDENTIAL =
  'no Claude credential is configured on the Worker. Store exactly one: ' +
  '`wrangler secret put CLAUDE_CODE_OAUTH_TOKEN` for a Claude subscription ' +
  '(get the token from `claude setup-token`), or ' +
  '`wrangler secret put ANTHROPIC_API_KEY` for the Claude API (get the key from ' +
  'the Claude Console).';

const BOTH_CREDENTIALS =
  'both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are configured on the Worker, ' +
  'so which account these jobs bill is undecided. Remove one of them with ' +
  '`wrangler secret delete <name>` — a subscription and an API account are ' +
  'different bills, and this executor will not guess between them.';

/** Whitespace is absence: a secret set to an empty string is one nobody set. */
function present(value: string | undefined): boolean {
  return (value ?? '').trim().length > 0;
}

export function claudeCredential(configured: ConfiguredCredentials): ClaudeCredential {
  const subscription = present(configured.oauthToken);
  const apiKey = present(configured.apiKey);

  if (subscription && apiKey) return { scheme: 'subscription', problem: BOTH_CREDENTIALS };
  if (apiKey) return { scheme: 'api-key' };
  if (subscription) return { scheme: 'subscription' };
  // The scheme here is only what an unusable command line will assume.
  return { scheme: 'subscription', problem: NO_CREDENTIAL };
}

/** How a probe or a log should name the scheme. */
export function describeScheme(scheme: ClaudeAuthScheme): string {
  return scheme === 'subscription' ? 'subscription-oauth' : 'anthropic-api-key';
}
