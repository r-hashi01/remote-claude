import { describe, expect, test } from 'vitest';
import { createRedactor } from '../domain/redaction/redactor';
import type { Env } from './env';
import { maskedSecrets } from './secrets';

const env = {
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-the-subscription-token',
  REMOTE_CLAUDE_TOKEN: 'the-shared-bearer-token',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----abcdefghijklmnop',
  R2_ACCESS_KEY_ID: 'r2-access-key-id-value',
  R2_SECRET_ACCESS_KEY: 'r2-secret-access-key-value',
  GITHUB_APP_ID: '1234567',
  GITHUB_APP_INSTALLATION_ID: '151907253',
} as unknown as Env;

describe('maskedSecrets', () => {
  // The session's redactor was built from three of these five. Everything it
  // emitted — agent messages, thoughts, errors — was masked with a list that
  // could not have masked an R2 key.
  test('every secret this deployment holds is masked by a redactor built from it', () => {
    const redact = createRedactor(maskedSecrets(env));

    for (const secret of [
      env.CLAUDE_CODE_OAUTH_TOKEN,
      env.REMOTE_CLAUDE_TOKEN,
      env.GITHUB_APP_PRIVATE_KEY,
      env.R2_ACCESS_KEY_ID,
      env.R2_SECRET_ACCESS_KEY,
    ] as string[]) {
      expect(redact(`before ${secret} after`)).toBe('before [redacted] after');
    }
  });

  test('an environment missing a secret simply has fewer of them', () => {
    expect(maskedSecrets({} as Env).filter(Boolean)).toEqual([]);
  });

  // Masking a six-digit App ID would corrupt unrelated output — a line number,
  // a byte count — while protecting an identifier that is not a credential.
  test('the numeric GitHub identifiers are not masked', () => {
    expect(maskedSecrets(env)).not.toContain(env.GITHUB_APP_ID);
    expect(maskedSecrets(env)).not.toContain(env.GITHUB_APP_INSTALLATION_ID);
  });
});
