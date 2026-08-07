import { getSandbox } from '@cloudflare/sandbox';
import type {
  CloneOptions,
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  SandboxProvider,
  SandboxSession,
  SnapshotOptions,
  SnapshotRef,
} from './types';
import type { Env } from '../types';

const PROVIDER_NAME = 'cloudflare';

type CloudflareSandbox = ReturnType<typeof getSandbox>;

/**
 * Cloudflare Sandbox SDK implementation of SandboxProvider.
 *
 * This is the only file in the codebase that may import `@cloudflare/sandbox`
 * for execution purposes. (`sandbox.ts` also imports it, but to *define* the
 * Durable Object class and its credential-injection handlers, which is a
 * deployment concern rather than an execution one.)
 */
export class CloudflareSandboxProvider implements SandboxProvider {
  readonly name = PROVIDER_NAME;

  constructor(
    private readonly env: Env,
    /** Where snapshots are stored. Absent means snapshotting is unavailable. */
    private readonly backupBucket?: R2Bucket
  ) {}

  async create(sandboxId: string, options: CreateSandboxOptions = {}): Promise<SandboxSession> {
    const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
      ...(options.sleepAfter ? { sleepAfter: options.sleepAfter } : {}),
      // Shell state must not leak between commands; every exec carries its own
      // cwd and env explicitly.
      enableDefaultSession: false,
    });
    return new CloudflareSandboxSession(sandboxId, sandbox, this.backupBucket);
  }
}

class CloudflareSandboxSession implements SandboxSession {
  constructor(
    readonly id: string,
    private readonly sandbox: CloudflareSandbox,
    private readonly backupBucket?: R2Bucket
  ) {}

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.sandbox.exec(command, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      ...(options.onOutput ? { stream: true, onOutput: options.onOutput } : {}),
    });

    return {
      success: result.success,
      exitCode: result.exitCode ?? (result.success ? 0 : 1),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  async cloneRepository(repoUrl: string, options: CloneOptions): Promise<void> {
    // Credentials are attached by the Worker's outbound handler for github.com,
    // so the URL passed here stays clean and nothing lands in .git/config.
    await this.sandbox.gitCheckout(repoUrl, {
      targetDir: options.targetDir,
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.depth ? { depth: options.depth } : {}),
    });
  }

  async killAll(): Promise<void> {
    await this.sandbox.killAllProcesses();
  }

  async snapshot(options: SnapshotOptions): Promise<SnapshotRef | null> {
    if (!this.backupBucket) return null;
    try {
      const backup = await this.sandbox.createBackup({
        dir: options.dir,
        ...(options.name ? { name: options.name } : {}),
        ...(options.ttlSeconds ? { ttl: options.ttlSeconds } : {}),
        ...(options.respectGitignore ? { gitignore: true } : {}),
      });
      return { provider: PROVIDER_NAME, id: backup.id, dir: backup.dir };
    } catch {
      // A snapshot is an optimisation; failing to take one must never break
      // the caller's work.
      return null;
    }
  }

  async restore(ref: SnapshotRef): Promise<boolean> {
    if (!this.backupBucket) return false;
    if (ref.provider !== PROVIDER_NAME) return false;
    try {
      const result = await this.sandbox.restoreBackup({
        id: String(ref.id),
        dir: String(ref.dir),
      });
      return result.success;
    } catch {
      // Expired or missing snapshot — the caller falls back to a fresh clone.
      return false;
    }
  }

  /**
   * Cloudflare has no explicit pause. Containers sleep on their own after
   * `sleepAfter` of inactivity, so the honest mapping is "stop holding it
   * awake" rather than a synchronous suspend.
   */
  async pause(): Promise<void> {
    await this.sandbox.setKeepAlive(false);
  }

  /** Any subsequent operation wakes a sleeping container, so this is a no-op. */
  async resume(): Promise<void> {
    // Intentionally empty — see pause().
  }

  async destroy(): Promise<void> {
    await this.sandbox.destroy();
  }
}
