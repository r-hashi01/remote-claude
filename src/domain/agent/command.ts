import { shellQuote } from '../shell/quote';

/**
 * The `claude` invocation for one turn.
 *
 * `unset` first as a second layer: the exec environment already unsets these
 * (see `claudeProcessEnvironment`), and this repeats it in the shell that
 * actually runs `claude`, because a fallback to API-key billing is the one
 * failure here that would be silent. The container is separately checked for
 * them by the runner's `verify-no-api-key` step, so this is the middle of three.
 *
 * `--verbose` is required alongside `--output-format stream-json` — Claude Code
 * rejects the latter without it.
 */
export function buildClaudeCommand(prompt: string, resumeId: string | null): string {
  const parts = [
    'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;',
    'claude -p',
    shellQuote(prompt),
    '--output-format stream-json',
    '--verbose',
    '--permission-mode bypassPermissions',
  ];
  if (resumeId) parts.push('--resume', shellQuote(resumeId));
  return parts.join(' ');
}
