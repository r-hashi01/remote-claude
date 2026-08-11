import type { WorkspaceRef } from '../../domain/job/record';

/**
 * Sandbox provider abstraction.
 *
 * Spindle deliberately does not own sandbox infrastructure (requirements §6.4).
 * Everything above this interface — task state, updates, outputs — must stay
 * independent of which provider actually runs the work, so that swapping
 * Cloudflare for another backend is a matter of adding one file here.
 *
 * The method set mirrors the shape the requirements call for:
 *   create / start / pause / resume / exec / snapshot / destroy
 *
 * Deliberate omissions: nothing here exposes a Durable Object, a container id,
 * or any other Cloudflare concept. If a caller needs one of those, the
 * abstraction is leaking and should be fixed here rather than worked around.
 */

export interface ExecOptions {
  cwd?: string;
  /** `undefined` for a key unsets that variable inside the sandbox. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Called as output arrives. Presence of this enables streaming. */
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
}

export interface ExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CloneOptions {
  targetDir: string;
  branch?: string;
  depth?: number;
}

export interface SnapshotOptions {
  dir: string;
  name?: string;
  ttlSeconds?: number;
  /**
   * Exclude paths matched by .gitignore.
   *
   * Only effective when `dir` is itself inside a git repository. For a directory
   * above the repository, use `excludes`.
   */
  respectGitignore?: boolean;
  /** Glob patterns to leave out, regardless of git. */
  excludes?: string[];
}

/**
 * Opaque, JSON-serializable pointer to a stored snapshot.
 *
 * Defined by the domain, because the job record carries it.
 *
 * Callers must persist and pass it back verbatim; only the provider that
 * produced it may interpret its contents. `provider` exists so a restore
 * against a different backend fails loudly instead of silently misbehaving.
 */
export type SnapshotRef = WorkspaceRef;

/** A running (or lazily startable) sandbox instance. */
export interface SandboxSession {
  readonly id: string;

  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /**
   * Clone a repository into the sandbox.
   *
   * Authentication is the provider's responsibility. This is intentional: the
   * Cloudflare provider injects a GitHub App token in the Workers runtime so
   * no credential ever reaches the container, and a different backend would
   * need a different mechanism. Callers must never embed credentials in the
   * URL they pass here.
   */
  cloneRepository(repoUrl: string, options: CloneOptions): Promise<void>;

  /** Write a file, creating parent directories as needed. */
  writeFile(path: string, content: string): Promise<void>;

  /** Read a file. Returns null when it does not exist. */
  readFile(path: string): Promise<string | null>;

  /**
   * Start a long-running process the platform owns.
   *
   * Distinct from `exec`, which runs a command and waits. This is for the runner,
   * which has to outlive the call that started it — and the reason it exists as a
   * port at all is that doing it by hand did not reliably work: a `setsid nohup …
   * &` inside an exec left the runner dead and silent in two of the first five
   * launches, with nothing to ask about it afterwards.
   *
   * `id` is chosen by the caller so the process can be found again after this
   * side restarts.
   */
  startProcess(command: string, options: StartProcessOptions): Promise<SandboxProcess>;

  /** The process with this id, or null when the platform has none. */
  findProcess(id: string): Promise<SandboxProcess | null>;

  /** Terminate every running process, leaving the sandbox itself alive. */
  killAll(): Promise<void>;

  /**
   * Returns null when this deployment keeps no workspaces. Throws when storing
   * one was attempted and failed — the caller decides whether that matters.
   */
  snapshot(options: SnapshotOptions): Promise<SnapshotRef | null>;

  /** Returns false when the snapshot is missing, expired or unusable. */
  restore(ref: SnapshotRef): Promise<boolean>;

  /** Stop consuming compute while preserving state, if the provider can. */
  pause(): Promise<void>;

  /** Undo `pause`. Providers that resume implicitly may no-op. */
  resume(): Promise<void>;

  /** Permanently delete the sandbox and all of its state. */
  destroy(): Promise<void>;
}

export interface StartProcessOptions {
  /** Chosen by the caller, so it can be found again. */
  id: string;
  cwd?: string;
  /** `undefined` for a key unsets that variable inside the sandbox. */
  env?: Record<string, string | undefined>;
}

/**
 * A process the platform is holding for us.
 *
 * `alive` answers the question the executor used to infer from the absence of a
 * file: is the runner still there. `output` is what it has printed, which is the
 * only thing that can say why it stopped.
 */
export interface SandboxProcess {
  readonly id: string;
  alive(): Promise<boolean>;
  output(): Promise<string>;
  kill(): Promise<void>;
}

export interface CreateSandboxOptions {
  /** Idle duration before the provider may reclaim compute, e.g. "5m". */
  sleepAfter?: string;
}

export interface SandboxProvider {
  readonly name: string;

  /**
   * Get or create the sandbox with this id.
   *
   * Implementations should be idempotent: the same id must return a session
   * addressing the same underlying sandbox, so a task can reattach after the
   * caller restarts.
   */
  create(sandboxId: string, options?: CreateSandboxOptions): Promise<SandboxSession>;
}
