import { CloudflareSandboxProvider } from './cloudflare';
import type { SandboxProvider } from '../../application/ports/sandbox';
import type { Env } from '../env';

export type {
  CloneOptions,
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  SandboxProvider,
  SandboxSession,
  SnapshotOptions,
  SnapshotRef,
} from '../../application/ports/sandbox';

/**
 * Resolve the configured sandbox provider.
 *
 * Only one backend exists today. The point of routing every caller through
 * this function is that adding a second one is a change to this file and one
 * new implementation — not a change to task execution, agent sessions, or
 * anything else above the abstraction.
 */
export function getSandboxProvider(env: Env): SandboxProvider {
  const requested = (env.SANDBOX_PROVIDER ?? 'cloudflare').trim().toLowerCase();

  switch (requested) {
    case 'cloudflare':
      return new CloudflareSandboxProvider(env, env.BACKUP_BUCKET);
    default:
      throw new Error(
        `unknown SANDBOX_PROVIDER "${requested}" (supported: cloudflare)`
      );
  }
}
