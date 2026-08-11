import {
  NdjsonBuffer,
  rpcNotify,
  translateEvent,
  type SessionUpdate,
  type StopReason,
} from '../domain/agent/acp';
import { buildClaudeCommand } from '../domain/agent/command';
import { sanitizeRef } from '../domain/job/branch';
import { Refusal } from '../domain/job/errors';
import { resolveRepository } from '../domain/job/repository';
import type {
  Background,
  ExecutorPolicy,
  GitHubAccess,
  Redact,
  SandboxProvider,
  SandboxSession,
  SessionStore,
  UpdateSink,
} from './ports';
import { REPO_DIR } from './workspace';



export interface AgentSessionDeps {
  /** Uses repoUrl / defaultBaseBranch / allowCustomRepo / claudeTimeoutMs / sleepAfter. */
  policy: ExecutorPolicy;
  sandboxes: SandboxProvider;
  /** This session's sandbox id, made by the Durable Object. */
  sandboxId: string;
  session: SessionStore;
  updates: UpdateSink;
  github: GitHubAccess;
  redact: Redact;
  background: Background;
  /** Environment for the `claude` process, built by the Durable Object. */
  claudeEnvironment: () => Record<string, string | undefined>;
}

/**
 * One interactive ACP session, as a use case rather than as a Durable Object.
 *
 * Everything about *what a turn does* lives here: which repository it runs
 * against, cloning it once, resuming Claude Code's own session across turns,
 * translating its stream-json into ACP updates, and reporting how a turn ended.
 * What used to be here and is not: SQLite, SSE framing, and waitUntil — those
 * stay in `src/infrastructure/durable-objects/agent-session.ts`, on the other
 * side of the ports.
 */
export class AgentSessionService {
  private readonly deps: AgentSessionDeps;
  private turn: AbortController | null = null;

  constructor(deps: AgentSessionDeps) {
    this.deps = deps;
  }

  /**
   * Decide which repository this session runs against, once, at creation.
   *
   * Uses exactly the rule a job uses (`resolveRepository`): the deployment's
   * configured repository unless the caller names another one and this
   * deployment allows that, in which case reachability is confirmed before the
   * session is usable — the same reason `JobService.createJob` checks before
   * queuing rather than letting a clone fail minutes later.
   */
  async start(input: { repo?: string; baseBranch?: string }): Promise<{ repo: string; baseBranch: string }> {
    const { policy, github, session } = this.deps;

    const { repo, isCustom } = resolveRepository(input.repo, policy.repoUrl, policy.allowCustomRepo);
    if (isCustom) await github.assertRepositoryReachable(repo);
    const baseBranch = sanitizeRef(input.baseBranch || policy.defaultBaseBranch);

    session.save({ repo, baseBranch });
    return { repo, baseBranch };
  }

  /** `session/prompt`. Returns immediately; the turn streams over the update sink. */
  async prompt(sessionId: string, text: string): Promise<{ accepted: true }> {
    if (this.turn) throw new Refusal('a turn is already in flight for this session');

    const controller = new AbortController();
    this.turn = controller;
    this.deps.background.run(() => this.runTurn(sessionId, text, controller));
    return { accepted: true };
  }

  /** `session/cancel` — a notification upstream, so this never throws. */
  cancel(): void {
    this.turn?.abort();
  }

  async close(): Promise<void> {
    this.turn?.abort();
    try {
      await (await this.sandbox()).destroy();
    } catch {
      /* already gone */
    }
    this.deps.session.clear();
  }

  // --------------------------------------------------------------- turn

  private async runTurn(sessionId: string, text: string, controller: AbortController): Promise<void> {
    const { policy, redact, session } = this.deps;
    const sandbox = await this.sandbox();

    // Echo the user's turn so a client that joins mid-session sees full history.
    this.emitUpdate(sessionId, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
    });

    let stopReason: StopReason = 'end_turn';
    try {
      await this.ensureRepo(sandbox, sessionId);

      const buffer = new NdjsonBuffer();
      const resume = session.load().claudeSessionId ?? null;
      const command = buildClaudeCommand(text, resume);

      const exec = sandbox.exec(command, {
        cwd: REPO_DIR,
        timeoutMs: policy.claudeTimeoutMs,
        env: this.deps.claudeEnvironment(),
        onOutput: (stream, data) => {
          if (stream !== 'stdout') return;
          for (const event of buffer.push(data)) {
            const translated = translateEvent(event);
            if (translated.claudeSessionId && translated.claudeSessionId !== session.load().claudeSessionId) {
              session.save({ claudeSessionId: translated.claudeSessionId });
            }
            for (const update of translated.updates) this.emitUpdate(sessionId, update);
            if (translated.stopReason) stopReason = translated.stopReason;
          }
        },
      });

      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            void sandbox.killAll().catch(() => {});
            reject(new Error('cancelled'));
          },
          { once: true }
        );
      });

      const result = await Promise.race([exec, aborted]);
      if (!result.success && !controller.signal.aborted) {
        this.emitUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `\n[claude exited ${result.exitCode}]\n${redact(result.stderr ?? '')}` },
        });
      }
    } catch (error) {
      stopReason = controller.signal.aborted ? 'cancelled' : 'end_turn';
      if (!controller.signal.aborted) {
        this.emitUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `\n[session error] ${redact(errorMessage(error))}` },
        });
      }
    } finally {
      this.turn = null;
      // Our out-of-band signal that the turn is over. The bridge converts this
      // into the JSON-RPC response to `session/prompt`.
      this.deps.updates.emit({ jsonrpc: '2.0', method: '_remoteClaude/turnEnd', params: { sessionId, stopReason } });
    }
  }

  /** Clone once per session; later turns reuse the same working tree. */
  private async ensureRepo(sandbox: SandboxSession, sessionId: string): Promise<void> {
    const { redact, session, policy } = this.deps;
    const state = session.load();
    if (state.prepared) return;

    const repo = state.repo ?? policy.repoUrl;
    const baseBranch = state.baseBranch ?? policy.defaultBaseBranch;

    this.emitUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `Preparing ${redact(repo)} (${baseBranch})…` },
    });

    await sandbox.cloneRepository(repo, { branch: baseBranch, targetDir: REPO_DIR });
    session.save({ prepared: true });
  }

  private emitUpdate(sessionId: string, update: SessionUpdate): void {
    this.deps.updates.emit(rpcNotify('session/update', { sessionId, update }));
  }

  private sandbox(): Promise<SandboxSession> {
    return this.deps.sandboxes.create(this.deps.sandboxId, { sleepAfter: this.deps.policy.sleepAfter });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
