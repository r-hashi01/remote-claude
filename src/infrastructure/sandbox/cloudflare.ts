import { getSandbox } from '@cloudflare/sandbox';
import type {
  CloneOptions,
  SandboxProcess,
  StartProcessOptions,
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  SandboxProvider,
  SandboxSession,
  SnapshotOptions,
  SnapshotRef,
} from '../../application/ports/sandbox';
import type { Env } from '../env';

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

  /**
   * Hand the runner to the platform.
   *
   * The alternative — backgrounding it from a shell inside `exec` — depended on
   * that shell's session outliving the call, and twice in the first five launches
   * it did not: the runner was gone, had written nothing, and there was nothing
   * left to ask. A process the platform owns can be asked.
   */
  async startProcess(command: string, options: StartProcessOptions): Promise<SandboxProcess> {
    const started = await this.sandbox.startProcess(command, {
      processId: options.id,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    return this.wrapProcess(started);
  }

  async findProcess(id: string): Promise<SandboxProcess | null> {
    const processes = await this.sandbox.listProcesses();
    const found = processes.find((process) => process.id === id);
    return found ? this.wrapProcess(found) : null;
  }

  private wrapProcess(process: { id: string }): SandboxProcess {
    const sandbox = this.sandbox;
    return {
      id: process.id,
      alive: async () => {
        const current = (await sandbox.listProcesses()).find((p) => p.id === process.id);
        // Absent means the platform has forgotten it, which for our purposes is
        // the same as gone.
        return current ? current.status === 'running' || current.status === 'starting' : false;
      },
      output: async () => {
        const logs = await sandbox.getProcessLogs(process.id).catch(() => null);
        if (!logs) return '';
        return [logs.stdout, logs.stderr].filter(Boolean).join('\n');
      },
      kill: async () => {
        await sandbox.killProcess(process.id).catch(() => {});
      },
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sandbox.writeFile(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const file = await this.sandbox.readFile(path);
      // The SDK returns either the text or an object wrapping it depending on
      // options; normalise so callers only ever see a string.
      return typeof file === 'string' ? file : ((file as { content?: string })?.content ?? null);
    } catch {
      // Missing file. The poller treats absence as "not written yet".
      return null;
    }
  }

  /**
   * A window of a file, and its current length.
   *
   * One command, because two would describe two moments: `wc -c` first on its own
   * line, then the bytes. A file that does not exist yet reports length zero
   * rather than failing — the runner creates it when it first has something to
   * say, and a watcher may well be attached before that.
   */
  async readWindow(
    path: string,
    offset: number,
    limit: number,
  ): Promise<{ chunk: string; size: number }> {
    const quoted = `'${path.replaceAll("'", "'\\''")}'`;
    const result = await this.sandbox.exec(
      `f=${quoted}; if [ ! -f "$f" ]; then echo 0; else wc -c < "$f" | tr -d ' '; ` +
        `tail -c +${Math.max(0, Math.floor(offset)) + 1} "$f" | head -c ${Math.max(0, Math.floor(limit))}; fi`
    );

    const stdout = result.stdout ?? '';
    const firstLine = stdout.indexOf('\n');
    if (firstLine === -1) return { chunk: '', size: 0 };

    return {
      size: Number.parseInt(stdout.slice(0, firstLine), 10) || 0,
      chunk: stdout.slice(firstLine + 1),
    };
  }

  async killAll(): Promise<void> {
    await this.sandbox.killAllProcesses();
  }

  /**
   * Store a directory, so a later sandbox can start from it.
   *
   * Null means only one thing: no bucket is bound, so this deployment does not
   * keep workspaces. **Failures throw.** They used to be swallowed here on the
   * grounds that a snapshot is an optimisation — which stopped being true when
   * continuing a job came to depend on it (ADR 0011). The first continuation
   * anybody tried was refused with "kept no workspace", and the reason it was
   * missing was nowhere to be found.
   *
   * `excludes` rather than `gitignore` for node_modules: the SDK applies git
   * rules only when the directory is itself inside a repository, and `/workspace`
   * is not — the repository is one level down. Asking for gitignore there is a
   * request that silently does nothing.
   */
  async snapshot(options: SnapshotOptions): Promise<SnapshotRef | null> {
    if (!this.backupBucket) return null;
    const backup = await this.sandbox.createBackup({
      dir: options.dir,
      ...(options.name ? { name: options.name } : {}),
      ...(options.ttlSeconds ? { ttl: options.ttlSeconds } : {}),
      ...(options.respectGitignore ? { gitignore: true } : {}),
      ...(options.excludes ? { excludes: options.excludes } : {}),
    });
    return { provider: PROVIDER_NAME, id: backup.id, dir: backup.dir };
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
