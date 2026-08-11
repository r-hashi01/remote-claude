/**
 * Environment for the `claude` process, wherever it runs (job pipeline,
 * interactive ACP session, health probe).
 *
 * `undefined` unsets the variable rather than passing an empty string — that's
 * the Sandbox exec contract. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
 * `ANTHROPIC_BASE_URL` are always unset so nothing ambient leaks into the
 * container; in proxy mode the real OAuth token never enters it either, only a
 * sentinel the Worker's outbound handler swaps out (ADR 0002).
 */
export interface ClaudeProcessOptions {
  authMode: 'proxy' | 'direct';
  /** The real token, used only in direct mode. Unused (and never surfaced) in proxy mode. */
  oauthToken: string | undefined;
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
  return {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: options.authMode === 'proxy' ? 'proxy-injected' : options.oauthToken,
    IS_SANDBOX: '1',
    CLAUDE_CONFIG_DIR,
    ...(options.ci ? { CI: '1' } : {}),
  };
}
