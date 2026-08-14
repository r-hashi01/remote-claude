import { unsetForeignCredentials } from '../../domain/agent/command';
import { describeScheme } from '../../domain/agent/credential';
import { claudeProcessEnvironment } from '../../domain/agent/environment';
import { patternOnlyRedactor } from '../../domain/redaction/redactor';
import { shellQuote } from '../../domain/shell/quote';
import { loadConfig } from '../config';
import type { Env } from '../env';
import { getSandboxProvider } from '../sandbox';

/**
 * End-to-end check that Claude Code authenticates with whatever credential this
 * deployment holds.
 *
 * Spends a negligible amount of quota in a real sandbox, so it is an explicit
 * endpoint rather than part of every job. It reports which credential answered:
 * "it works" is not the whole question when there are two schemes and only one
 * of them is billing the account somebody expects.
 */
export async function probeClaudeAuth(env: Env): Promise<Response> {
  const config = loadConfig(env);
  // Nothing configured, or both configured — either way there is no request to
  // make, and the reason is the answer.
  if (config.claudeCredentialProblem) {
    return Response.json({ ok: false, reason: config.claudeCredentialProblem }, { status: 503 });
  }

  const scheme = config.claudeAuthScheme;
  const sandbox = await getSandboxProvider(env).create('health-auth', { sleepAfter: '1m' });
  try {
    const probe = await sandbox.exec(
      `${unsetForeignCredentials(scheme)} claude -p ${shellQuote('Reply with exactly: OK')}`,
      {
        cwd: '/workspace',
        timeoutMs: 120_000,
        // ANTHROPIC_BASE_URL is unset here too (it wasn't before) — otherwise the
        // probe could inherit a base URL meant for the proxy and validate the
        // wrong endpoint (ADR 0002).
        env: claudeProcessEnvironment({
          authMode: config.claudeAuthMode,
          scheme,
          oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
          apiKey: env.ANTHROPIC_API_KEY,
          ci: false,
        }),
      }
    );

    return Response.json({
      ok: probe.success,
      authMode: config.claudeAuthMode,
      authScheme: describeScheme(scheme),
      // What the field has always meant: a real API key sitting inside the
      // container. True only where one is deliberately put there — the API-key
      // scheme in direct mode. In proxy mode the container holds the sentinel,
      // whichever scheme is configured.
      apiKeyInContainer: scheme === 'api-key' && config.claudeAuthMode === 'direct',
      // Whichever credential it is. `apiKeyInContainer` cannot say that a
      // subscription token was handed over in direct mode, and that is the same
      // fact about the same choice.
      credentialInContainer: config.claudeAuthMode === 'direct',
      // Absent means Claude Code's own default, which is a real answer.
      model: config.model,
      // Redact defensively: this is model output.
      output: patternOnlyRedactor((probe.success ? probe.stdout : probe.stderr).trim().slice(0, 500)),
    });
  } finally {
    await sandbox.destroy().catch(() => {});
  }
}
