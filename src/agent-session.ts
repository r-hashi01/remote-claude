import { DurableObject } from 'cloudflare:workers';
import { getSandboxProvider, type SandboxSession } from './providers';
import {
  NdjsonBuffer,
  rpcNotify,
  translateEvent,
  type SessionUpdate,
  type StopReason,
} from './acp';
import { loadConfig, type Config } from './config';
import { createRedactor, type Redactor } from './redact';
import { shellQuote } from './runner';
import type { Env } from './types';

const REPO_DIR = '/workspace/repo';
const MAX_UPDATES = 10_000;

/**
 * One ACP session, backed by one Sandbox.
 *
 * Why a turn is a fresh `claude` invocation rather than a long-lived process:
 * the Sandbox SDK's `exec`/`startProcess` accept `stdin` as a one-shot string,
 * so there is no bidirectional pipe to hold open. Claude Code's own
 * `--session-id` / `--resume` gives us multi-turn continuity instead, and the
 * conversation state lives on the sandbox disk between turns.
 */
export class AgentSession extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Live SSE subscribers. */
  private readonly subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private seq = 0;
  private turn: AbortController | null = null;
  /** Claude Code's session id, captured from its init event, used for --resume. */
  private claudeSessionId: string | null = null;
  private prepared = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS updates (
          seq  INTEGER PRIMARY KEY,
          ts   INTEGER NOT NULL,
          body TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      const row = this.sql
        .exec<{ max_seq: number | null }>('SELECT MAX(seq) AS max_seq FROM updates')
        .toArray()[0];
      this.seq = row?.max_seq ?? 0;
      this.claudeSessionId = this.readMeta('claudeSessionId');
      this.prepared = this.readMeta('prepared') === 'true';
    });
  }

  // ------------------------------------------------------------------ SSE

  /**
   * Server→client stream. Modeled on the ACP remote-transport RFD's
   * session-scoped SSE stream; `?since=` replays missed updates, which the RFD
   * currently leaves unsolved (no `Last-Event-ID` support).
   */
  async fetch(request: Request): Promise<Response> {
    const since = Number.parseInt(new URL(request.url).searchParams.get('since') ?? '0', 10) || 0;

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.subscribers.add(writer);

    // Replay first so a reconnecting client sees a complete transcript.
    for (const row of this.sql
      .exec<{ seq: number; body: string }>('SELECT seq, body FROM updates WHERE seq > ? ORDER BY seq', since)
      .toArray()) {
      void writer.write(encodeSse(row.seq, row.body));
    }

    void request.signal?.addEventListener?.('abort', () => this.dropSubscriber(writer));

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  }

  private dropSubscriber(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    this.subscribers.delete(writer);
    void writer.close().catch(() => {});
  }

  /** Persist an ACP message and fan it out to every live subscriber. */
  private emit(message: unknown): void {
    if (this.seq >= MAX_UPDATES) return;
    this.seq += 1;
    const body = JSON.stringify(message);
    this.sql.exec('INSERT INTO updates (seq, ts, body) VALUES (?, ?, ?)', this.seq, Date.now(), body);

    const frame = encodeSse(this.seq, body);
    for (const writer of this.subscribers) {
      void writer.write(frame).catch(() => this.dropSubscriber(writer));
    }
  }

  private emitUpdate(sessionId: string, update: SessionUpdate): void {
    this.emit(rpcNotify('session/update', { sessionId, update }));
  }

  // ---------------------------------------------------------------- RPC

  /** `session/prompt`. Returns immediately; the turn streams over SSE. */
  async prompt(sessionId: string, text: string): Promise<{ accepted: true }> {
    if (this.turn) throw new Error('a turn is already in flight for this session');

    const controller = new AbortController();
    this.turn = controller;
    this.ctx.waitUntil(this.runTurn(sessionId, text, controller));
    return { accepted: true };
  }

  /** `session/cancel` — a notification upstream, so this never throws. */
  async cancel(): Promise<void> {
    this.turn?.abort();
  }

  async close(): Promise<void> {
    this.turn?.abort();
    try {
      await (await this.sandbox()).destroy();
    } catch {
      /* already gone */
    }
    for (const writer of [...this.subscribers]) this.dropSubscriber(writer);
    this.sql.exec('DELETE FROM updates');
    this.sql.exec('DELETE FROM meta');
    this.seq = 0;
    this.prepared = false;
    this.claudeSessionId = null;
  }

  // --------------------------------------------------------------- turn

  private async runTurn(sessionId: string, text: string, controller: AbortController): Promise<void> {
    const config = loadConfig(this.env);
    const redact = createRedactor([
      this.env.CLAUDE_CODE_OAUTH_TOKEN,
      this.env.GITHUB_APP_PRIVATE_KEY,
      this.env.REMOTE_CLAUDE_TOKEN,
    ]);
    const sandbox = await this.sandbox();

    // Echo the user's turn so a client that joins mid-session sees full history.
    this.emitUpdate(sessionId, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
    });

    let stopReason: StopReason = 'end_turn';
    try {
      await this.ensureRepo(sandbox, config, redact, sessionId);

      const buffer = new NdjsonBuffer();
      const resume = this.claudeSessionId;
      const command = buildClaudeCommand(text, resume);

      const exec = sandbox.exec(command, {
        cwd: REPO_DIR,
        timeoutMs: config.claudeTimeoutMs,
        env: claudeEnvironment(this.env, config),
        onOutput: (stream, data) => {
          if (stream !== 'stdout') return;
          for (const event of buffer.push(data)) {
            const translated = translateEvent(event);
            if (translated.claudeSessionId && translated.claudeSessionId !== this.claudeSessionId) {
              this.claudeSessionId = translated.claudeSessionId;
              this.writeMeta('claudeSessionId', translated.claudeSessionId);
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
      this.emit({ jsonrpc: '2.0', method: '_remoteClaude/turnEnd', params: { sessionId, stopReason } });
    }
  }

  /** Clone once per session; later turns reuse the same working tree. */
  private async ensureRepo(
    sandbox: SandboxSession,
    config: Config,
    redact: Redactor,
    sessionId: string
  ): Promise<void> {
    if (this.prepared) return;

    this.emitUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `Preparing ${redact(config.repoUrl)} (${config.defaultBaseBranch})…` },
    });

    await sandbox.cloneRepository(config.repoUrl, {
      branch: config.defaultBaseBranch,
      targetDir: REPO_DIR,
    });
    this.prepared = true;
    this.writeMeta('prepared', 'true');
  }

  private sandbox(): Promise<SandboxSession> {
    const config = loadConfig(this.env);
    return getSandboxProvider(this.env).create(`acp-${this.ctx.id.toString().slice(0, 16)}`, {
      sleepAfter: config.sleepAfter,
    });
  }

  private readMeta(key: string): string | null {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return row?.value ?? null;
  }

  private writeMeta(key: string, value: string): void {
    this.sql.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value
    );
  }
}

// -------------------------------------------------------------- helpers

function buildClaudeCommand(prompt: string, resumeId: string | null): string {
  const parts = [
    'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;',
    'claude -p',
    shellQuote(prompt),
    '--output-format stream-json',
    // stream-json output is rejected without --verbose.
    '--verbose',
    '--permission-mode bypassPermissions',
  ];
  if (resumeId) parts.push('--resume', shellQuote(resumeId));
  return parts.join(' ');
}

function claudeEnvironment(env: Env, config: Config): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN:
      config.claudeAuthMode === 'proxy' ? 'proxy-injected' : env.CLAUDE_CODE_OAUTH_TOKEN,
    IS_SANDBOX: '1',
  };
}

function encodeSse(id: number, data: string): Uint8Array {
  return new TextEncoder().encode(`id: ${id}\ndata: ${data}\n\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
