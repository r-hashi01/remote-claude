import type { Env, Secrets } from './env';

/**
 * Every secret this deployment holds, for the redactor to mask.
 *
 * There were three redactors — the HTTP entry point, the job coordinator, and
 * the ACP session — each with its own hand-written list, and **the session's was
 * missing the two R2 keys**. Nobody edited a rule to make that happen; the rule
 * was simply written down three times.
 *
 * The `satisfies` clause is the part that matters: adding a credential to
 * `Secrets` and forgetting it here does not compile. That is a stronger
 * guarantee than a test, because the failure it prevents is one nobody would
 * think to test for.
 */
const MASKED = {
  CLAUDE_CODE_OAUTH_TOKEN: true,
  ANTHROPIC_API_KEY: true,
  REMOTE_CLAUDE_TOKEN: true,
  GITHUB_APP_PRIVATE_KEY: true,
  R2_ACCESS_KEY_ID: true,
  R2_SECRET_ACCESS_KEY: true,
} satisfies Record<keyof Secrets, true>;

/** The secret values present in this environment. Absent ones stay absent. */
export function maskedSecrets(env: Env): Array<string | undefined> {
  return (Object.keys(MASKED) as Array<keyof Secrets>).map((key) => env[key]);
}
