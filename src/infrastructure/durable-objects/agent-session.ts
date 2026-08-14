import { DurableObject } from 'cloudflare:workers';
import { AgentSessionService } from '../../application/agent-session-service';
import type { Background, SessionState, SessionStore, UpdateSink } from '../../application/ports';
import { claudeProcessEnvironment } from '../../domain/agent/environment';
import { createRedactor } from '../../domain/redaction/redactor';
import { loadConfig } from '../config';
import type { Env } from '../env';
import { maskedSecrets } from '../secrets';
import { GitHubAppAccess } from '../github/app';
import { getSandboxProvider } from '../sandbox';

const MAX_UPDATES = 10_000;

/**
 * One ACP session, backed by one Sandbox.
 *
 * This class is an adapter: it owns SSE subscribers, the SQLite tables that
 * back `SessionStore` and `UpdateSink`, and the `waitUntil` that lets a turn
 * outlive the request that started it. Everything about what a turn actually
 * does — which repository, cloning it, resuming Claude Code, translating its
 * output — lives in `AgentSessionService` (`src/application`), which this
 * class implements the ports for and delegates every RPC to.
 *
 * Why a turn is a fresh `claude` invocation rather than a long-lived process:
 * the Sandbox SDK's `exec`/`startProcess` accept `stdin` as a one-shot string,
 * so there is no bidirectional pipe to hold open. Claude Code's own
 * `--session-id` / `--resume` gives us multi-turn continuity instead, and the
 * conversation state lives on the sandbox disk between turns.
 */
export class AgentSession extends DurableObject<Env> implements SessionStore, UpdateSink, Background {
  private readonly sql: SqlStorage;
  /** Live SSE subscribers. */
  private readonly subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private seq = 0;
  private readonly service: AgentSessionService;

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
    });

    const config = loadConfig(env);
    this.service = new AgentSessionService({
      policy: config,
      sandboxes: getSandboxProvider(env),
      sandboxId: `acp-${ctx.id.toString().slice(0, 16)}`,
      session: this,
      updates: this,
      github: new GitHubAppAccess(env),
      redact: createRedactor(maskedSecrets(env)),
      background: this,
      claudeEnvironment: () =>
        claudeProcessEnvironment({
          authMode: config.claudeAuthMode,
          scheme: config.claudeAuthScheme,
          oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
          apiKey: env.ANTHROPIC_API_KEY,
          ci: false,
        }),
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

  // ---------------------------------------------------------- UpdateSink

  /** Persist an ACP message and fan it out to every live subscriber. */
  emit(message: unknown): void {
    if (this.seq >= MAX_UPDATES) return;
    this.seq += 1;
    const body = JSON.stringify(message);
    this.sql.exec('INSERT INTO updates (seq, ts, body) VALUES (?, ?, ?)', this.seq, Date.now(), body);

    const frame = encodeSse(this.seq, body);
    for (const writer of this.subscribers) {
      void writer.write(frame).catch(() => this.dropSubscriber(writer));
    }
  }

  // ---------------------------------------------------------- SessionStore

  load(): SessionState {
    return {
      claudeSessionId: this.readMeta('claudeSessionId') ?? undefined,
      prepared: this.readMeta('prepared') === 'true',
      repo: this.readMeta('repo') ?? undefined,
      baseBranch: this.readMeta('baseBranch') ?? undefined,
    };
  }

  save(state: Partial<SessionState>): void {
    if (state.claudeSessionId !== undefined) this.writeMeta('claudeSessionId', state.claudeSessionId);
    if (state.prepared !== undefined) this.writeMeta('prepared', String(state.prepared));
    if (state.repo !== undefined) this.writeMeta('repo', state.repo);
    if (state.baseBranch !== undefined) this.writeMeta('baseBranch', state.baseBranch);
  }

  clear(): void {
    this.sql.exec('DELETE FROM meta');
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

  // ----------------------------------------------------------- Background

  run(work: () => Promise<void>): void {
    this.ctx.waitUntil(work());
  }

  // ---------------------------------------------------------------- RPC

  /** Decide (and remember) which repository/branch this session runs against. */
  async start(input: { repo?: string; baseBranch?: string } = {}): Promise<{ repo: string; baseBranch: string }> {
    return this.service.start(input);
  }

  /** `session/prompt`. Returns immediately; the turn streams over SSE. */
  async prompt(sessionId: string, text: string): Promise<{ accepted: true }> {
    return this.service.prompt(sessionId, text);
  }

  /** `session/cancel` — a notification upstream, so this never throws. */
  async cancel(): Promise<void> {
    this.service.cancel();
  }

  async close(): Promise<void> {
    await this.service.close();
    for (const writer of [...this.subscribers]) this.dropSubscriber(writer);
    this.sql.exec('DELETE FROM updates');
    this.seq = 0;
  }
}

// -------------------------------------------------------------- helpers

function encodeSse(id: number, data: string): Uint8Array {
  return new TextEncoder().encode(`id: ${id}\ndata: ${data}\n\n`);
}
