import { PROXY_SENTINEL, type ClaudeAuthScheme } from './credential';

/**
 * Environment for the `claude` process, wherever it runs (job pipeline,
 * interactive ACP session, health probe).
 *
 * `undefined` unsets the variable rather than passing an empty string — that's
 * the Sandbox exec contract. Exactly one credential variable is ever set, and
 * every other one is unset by name, so nothing ambient can decide how Claude
 * Code authenticates: the scheme the deployment configured is the scheme the
 * container gets. In proxy mode even that variable holds only the sentinel the
 * Worker's outbound handler swaps out, so no real credential enters the
 * container (ADR 0002).
 *
 * `ANTHROPIC_BASE_URL` is always unset. A base URL meant for something else
 * would send the credential — real or sentinel — somewhere this deployment has
 * not allowed and cannot see.
 */
export interface ClaudeProcessOptions {
  authMode: 'proxy' | 'direct';
  /** Which credential this deployment holds. Decides which variable is set. */
  scheme: ClaudeAuthScheme;
  /** The real subscription token. Used only in direct mode, under `subscription`. */
  oauthToken: string | undefined;
  /** The real API key. Used only in direct mode, under `api-key`. */
  apiKey: string | undefined;
  /** True for the job pipeline; false for interactive sessions and the health probe. */
  ci: boolean;
}

/**
 * Where Claude Code keeps its conversations.
 *
 * By default that is the home directory, keyed by the working directory — which
 * puts the one thing needed to continue a job outside the one directory that can
 * be carried between sandboxes. Pointed inside the workspace, a single snapshot
 * holds both the tree and the conversation about it.
 *
 * The container's working directory is always the same path, so the key Claude
 * derives from it matches in any sandbox the workspace is restored into.
 */
export const CLAUDE_CONFIG_DIR = '/workspace/.claude';

export function claudeProcessEnvironment(
  options: ClaudeProcessOptions
): Record<string, string | undefined> {
  const subscription = options.scheme === 'subscription';
  // The real credential is only ever handed over in direct mode. In proxy mode
  // the container gets a string that is not a credential at all.
  const real = subscription ? options.oauthToken : options.apiKey;
  const value = options.authMode === 'proxy' ? PROXY_SENTINEL : real;

  return {
    ANTHROPIC_API_KEY: subscription ? undefined : value,
    CLAUDE_CODE_OAUTH_TOKEN: subscription ? value : undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    IS_SANDBOX: '1',
    CLAUDE_CONFIG_DIR,
    ...(options.ci ? { CI: '1' } : {}),
  };
}
