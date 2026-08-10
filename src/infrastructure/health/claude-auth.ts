import { claudeProcessEnvironment } from '../../domain/agent/environment';
import { patternOnlyRedactor } from '../../domain/redaction/redactor';
import { shellQuote } from '../../domain/shell/quote';
import { loadConfig } from '../config';
import type { Env } from '../env';
import { getSandboxProvider } from '../sandbox';

/**
 * End-to-end check that Claude Code authenticates with the subscription OAuth
 * token.
 *
 * Spends a negligible amount of quota in a real sandbox, so it is an explicit
 * endpoint rather than part of every job.
 */
export async function probeClaudeAuth(env: Env): Promise<Response> {
  const config = loadConfig(env);
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    return Response.json(
      { ok: false, reason: 'CLAUDE_CODE_OAUTH_TOKEN is not configured' },
      { status: 503 }
    );
  }

  const sandbox = await getSandboxProvider(env).create('health-auth', { sleepAfter: '1m' });
  try {
    const probe = await sandbox.exec(
      `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; claude -p ${shellQuote('Reply with exactly: OK')}`,
      {
        cwd: '/workspace',
        timeoutMs: 120_000,
        // ANTHROPIC_BASE_URL is unset here too (it wasn't before) — otherwise the
        // probe could inherit a base URL meant for the proxy and validate the
        // wrong endpoint (ADR 0002).
        env: claudeProcessEnvironment({
          authMode: config.claudeAuthMode,
          oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
          ci: false,
        }),
      }
    );

    return Response.json({
      ok: probe.success,
      authMode: config.claudeAuthMode,
      authScheme: 'subscription-oauth',
      apiKeyInContainer: false,
      // Redact defensively: this is model output.
      output: patternOnlyRedactor((probe.success ? probe.stdout : probe.stderr).trim().slice(0, 500)),
    });
  } finally {
    await sandbox.destroy().catch(() => {});
  }
}
