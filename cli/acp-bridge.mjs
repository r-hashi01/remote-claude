#!/usr/bin/env node
/**
 * ACP v1 agent over stdio, backed by the remote Cloudflare Sandbox.
 *
 * An editor (Zed, neovim, …) launches this as an ACP agent subprocess. It does
 * no model work and no build work — it only relays JSON-RPC. The actual Claude
 * Code process runs in the Sandbox, so the Mac pays for a small idle Node
 * process and nothing else.
 *
 *   editor ──ACP/stdio──▶ this bridge ──HTTPS+SSE──▶ Worker ──▶ Sandbox
 *
 * Why a bridge instead of native remote ACP: ACP's HTTP/WebSocket transport is
 * still an RFD proposal, whereas stdio is the stable, universally-implemented
 * transport. This gets editor integration working today and confines the churn
 * to one file when the remote transport stabilises.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- config

function loadConfig() {
  let fromFile = {};
  for (const path of [
    join(REPO_ROOT, '.remote-claude.json'),
    join(homedir(), '.config', 'remote-claude', 'config.json'),
  ]) {
    try {
      fromFile = JSON.parse(readFileSync(path, 'utf8'));
      break;
    } catch {
      /* next */
    }
  }
  const url = process.env.REMOTE_CLAUDE_URL || fromFile.url;
  const token = process.env.REMOTE_CLAUDE_TOKEN || fromFile.token;
  if (!url || !token) {
    process.stderr.write(
      'acp-bridge: set REMOTE_CLAUDE_URL and REMOTE_CLAUDE_TOKEN, or create .remote-claude.json\n'
    );
    process.exit(2);
  }
  return { url: url.replace(/\/+$/, ''), token };
}

const config = loadConfig();

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`worker ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response;
}

// ------------------------------------------------------------- transport

/** ACP stdio: one JSON object per line, no embedded newlines. */
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const log = (message) => process.stderr.write(`[acp-bridge] ${message}\n`);

// --------------------------------------------------------------- session

/** sessionId → { pendingPrompt: {id} | null, abort: AbortController } */
const sessions = new Map();

/**
 * Consume the Worker's SSE stream and re-emit each ACP message on stdout.
 *
 * The Worker sends genuine ACP `session/update` notifications plus one private
 * `_remoteClaude/turnEnd` marker. ACP has no notification that ends a turn —
 * the turn ends by *responding* to `session/prompt` — so the marker is what we
 * convert into that response.
 */
async function pumpEvents(sessionId, state) {
  let since = 0;

  for (;;) {
    try {
      const response = await fetch(`${config.url}/acp/sessions/${sessionId}/stream?since=${since}`, {
        headers: { authorization: `Bearer ${config.token}`, accept: 'text/event-stream' },
        signal: state.abort.signal,
      });
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const idLine = frame.match(/^id:\s*(\d+)$/m);
          const dataLine = frame.match(/^data:\s*(.*)$/m);
          if (idLine) since = Math.max(since, Number.parseInt(idLine[1], 10));
          if (!dataLine) continue;

          let message;
          try {
            message = JSON.parse(dataLine[1]);
          } catch {
            continue;
          }
          dispatchServerMessage(sessionId, state, message);
        }
      }
    } catch (error) {
      if (state.abort.signal.aborted) return;
      log(`stream dropped (${error.message}); reconnecting from ${since}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function dispatchServerMessage(sessionId, state, message) {
  if (message.method === '_remoteClaude/turnEnd') {
    const pending = state.pendingPrompt;
    state.pendingPrompt = null;
    if (pending) {
      send({ jsonrpc: '2.0', id: pending, result: { stopReason: message.params?.stopReason ?? 'end_turn' } });
    }
    return;
  }
  // Everything else is already a well-formed ACP message — pass it straight
  // through rather than re-deriving it.
  send(message);
}

// -------------------------------------------------------------- handlers

async function handle(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
        agentInfo: { name: 'remote-claude', title: 'Remote Claude (Cloudflare Sandbox)', version: '0.1.0' },
        authMethods: [],
      };

    case 'session/new': {
      const created = await (await api('/acp/sessions', { method: 'POST', body: {} })).json();
      const sessionId = created.sessionId;
      const state = { pendingPrompt: null, abort: new AbortController() };
      sessions.set(sessionId, state);
      // `cwd` from the client is intentionally ignored: the working tree lives
      // in the Sandbox, not on this machine.
      log(`session ${sessionId} (client cwd ${params?.cwd ?? '-'} ignored; remote workspace is authoritative)`);
      void pumpEvents(sessionId, state);
      return { sessionId };
    }

    case 'session/prompt': {
      const sessionId = params?.sessionId;
      const state = sessions.get(sessionId);
      if (!state) throw Object.assign(new Error('unknown session'), { code: -32602 });

      const text = (params?.prompt ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (!text) throw Object.assign(new Error('prompt must contain a text block'), { code: -32602 });

      // Hold the request id; the response is sent when turnEnd arrives.
      state.pendingPrompt = id;
      await api(`/acp/sessions/${sessionId}/prompt`, { method: 'POST', body: { text } });
      return undefined; // deferred
    }

    case 'session/cancel': {
      const state = sessions.get(params?.sessionId);
      if (state) await api(`/acp/sessions/${params.sessionId}/cancel`, { method: 'POST' }).catch(() => {});
      return undefined; // notification — no response
    }

    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

// ------------------------------------------------------------------ main

createInterface({ input: process.stdin }).on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }

  const isNotification = request.id === undefined || request.id === null;
  try {
    const result = await handle(request);
    // `undefined` means either a notification or a deferred response.
    if (!isNotification && result !== undefined) send({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    if (isNotification) {
      log(`notification ${request.method} failed: ${error.message}`);
      return;
    }
    send({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: error.code ?? -32603, message: error.message },
    });
  }
});

process.stdin.on('close', () => {
  for (const state of sessions.values()) state.abort.abort();
  process.exit(0);
});
