import { shellQuote } from '../shell/quote';
import type { ClaudeAuthScheme } from './credential';

/**
 * The credential variables a given scheme must not find set.
 *
 * One scheme's credential is the other's silent fallback. Under `subscription`,
 * a stray `ANTHROPIC_API_KEY` moves the bill from a flat subscription to
 * pay-as-you-go; under `api-key`, a stray `CLAUDE_CODE_OAUTH_TOKEN` moves it the
 * other way and onto a credential whose terms only cover the person who bought
 * it. Both directions are silent — the run works, and something else pays — so
 * the variables the chosen scheme does not use are unset by name.
 *
 * `ANTHROPIC_AUTH_TOKEN` is foreign to both: it is the bearer-token override,
 * and nothing here ever wants Claude Code taking one from the environment.
 */
export function foreignCredentialVariables(scheme: ClaudeAuthScheme): string[] {
  return scheme === 'subscription'
    ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
    : ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];
}

/**
 * The shell prefix that clears them, as a second layer.
 *
 * The exec environment already unsets these (see `claudeProcessEnvironment`);
 * this repeats it in the shell that actually runs `claude`, and the runner's
 * `verify-environment` step checks it a third time. Three layers, because the
 * failure they prevent is the one failure here that would be silent.
 */
export function unsetForeignCredentials(scheme: ClaudeAuthScheme): string {
  return `unset ${foreignCredentialVariables(scheme).join(' ')};`;
}

export interface ClaudeCommandOptions {
  prompt: string;
  /** The conversation to carry on, if this is not the first turn. */
  resumeId?: string | null;
  /** Which credential the deployment holds. Decides what is unset first. */
  scheme: ClaudeAuthScheme;
  /**
   * The model to run.
   *
   * Absent means Claude Code's own default, which is the right behaviour for a
   * deployment that has not asked for a particular model: the default moves as
   * models are released, and naming one here would freeze it.
   */
  model?: string | undefined;
}

/**
 * The `claude` invocation for one turn.
 *
 * `--verbose` is required alongside `--output-format stream-json` — Claude Code
 * rejects the latter without it.
 */
export function buildClaudeCommand(options: ClaudeCommandOptions): string {
  const parts = [
    unsetForeignCredentials(options.scheme),
    'claude -p',
    shellQuote(options.prompt),
    '--output-format stream-json',
    '--verbose',
    '--permission-mode bypassPermissions',
  ];
  if (options.model) parts.push('--model', shellQuote(options.model));
  if (options.resumeId) parts.push('--resume', shellQuote(options.resumeId));
  return parts.join(' ');
}
