/**
 * Agent Client Protocol (ACP) v1 — types and the Claude Code translation layer.
 *
 * Scope note: ACP v1 (`protocolVersion: 1`) is the stable surface. v2 exists but
 * is a draft that upstream explicitly says not to ship by default, and the
 * remote HTTP/WebSocket transport is still only an RFD proposal. So this file
 * models v1, and the remote hop is our own SSE channel (see agent-session.ts)
 * with a local stdio bridge presenting real ACP to the editor.
 *
 * Conventions from the spec that are easy to get wrong:
 *   - JSON keys are camelCase; discriminator *values* are snake_case.
 *   - All paths are absolute, line numbers are 1-based.
 *   - `session/update` is a NOTIFICATION — never reply to it.
 */

export const ACP_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- JSON-RPC

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;

export function rpcResult(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function rpcNotify(method: string, params: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

// ------------------------------------------------------------ ACP payloads

/** ContentBlock — deliberately identical to MCP's, so tool output forwards as-is. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'audio'; mimeType: string; data: string }
  | { type: 'resource'; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; size?: number };

export type ToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search'
  | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

export interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

/** The `update` object inside a `session/update` notification. */
export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock; messageId?: string }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock; messageId?: string }
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock; messageId?: string }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title: string;
      kind?: ToolKind;
      status?: ToolCallStatus;
      content?: ToolCallContent[];
      locations?: Array<{ path: string; line?: number }>;
      rawInput?: Record<string, unknown>;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      status?: ToolCallStatus;
      title?: string;
      content?: ToolCallContent[];
      rawOutput?: Record<string, unknown>;
    }
  | { sessionUpdate: 'plan'; entries: PlanEntry[] }
  | { sessionUpdate: 'usage_update'; used: number; size: number };

/** Exhaustive per the v1 schema. */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

// ------------------------------------------- Claude Code stream-json shapes

/**
 * Only the fields we consume. The real union has ~39 variants and grows, so the
 * translator ignores anything it does not recognise rather than failing.
 */
export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  message?: {
    id?: string;
    role?: string;
    content?: Array<Record<string, unknown>>;
  };
  result?: string;
  is_error?: boolean;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  [key: string]: unknown;
}

/** Claude Code tool name → the closest ACP ToolKind, for client-side iconography. */
const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Glob: 'read',
  LS: 'read',
  Grep: 'search',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Task: 'think',
  TodoWrite: 'think',
};

export function toolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? 'other';
}

/** Short human-readable title for a tool call, mirroring what editors display. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const path = typeof input.file_path === 'string' ? input.file_path : undefined;
  switch (name) {
    case 'Read':
      return path ? `Read ${basename(path)}` : 'Read file';
    case 'Edit':
    case 'MultiEdit':
      return path ? `Edit ${basename(path)}` : 'Edit file';
    case 'Write':
      return path ? `Write ${basename(path)}` : 'Write file';
    case 'Bash':
      return typeof input.command === 'string' ? truncateTitle(input.command) : 'Run command';
    case 'Grep':
      return typeof input.pattern === 'string' ? `Search "${truncateTitle(input.pattern)}"` : 'Search';
    case 'Glob':
      return typeof input.pattern === 'string' ? `Find ${truncateTitle(input.pattern)}` : 'Find files';
    case 'WebFetch':
      return typeof input.url === 'string' ? `Fetch ${truncateTitle(input.url)}` : 'Fetch URL';
    case 'TodoWrite':
      return 'Update plan';
    case 'Task':
      return typeof input.description === 'string' ? `Subagent: ${input.description}` : 'Subagent';
    default:
      return name;
  }
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function truncateTitle(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

// ------------------------------------------------------------- translation

/** Consumption reported by Claude Code, previously parsed and thrown away. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  turns: number | null;
}

export interface TranslationOutput {
  updates: SessionUpdate[];
  /** Present on the result event. */
  usage?: AgentUsage;
  /** Set when this event ends the turn. */
  stopReason?: StopReason;
  /** Claude Code's own session id, from the init event — needed for --resume. */
  claudeSessionId?: string;
  /** Final assistant text, present on the result event. */
  finalText?: string;
}

/**
 * Translate one Claude Code stream-json event into ACP session updates.
 *
 * Unknown event types produce no updates — the CLI's event union is large and
 * still growing, and silently ignoring is the documented-safe posture.
 */
export function translateEvent(event: ClaudeStreamEvent): TranslationOutput {
  const updates: SessionUpdate[] = [];

  switch (event.type) {
    case 'system': {
      if (event.subtype === 'init') {
        return { updates, claudeSessionId: event.session_id };
      }
      return { updates };
    }

    case 'assistant': {
      const messageId = event.message?.id;
      for (const block of event.message?.content ?? []) {
        const blockType = block.type;

        if (blockType === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          updates.push({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: block.text },
            ...(messageId ? { messageId } : {}),
          });
        } else if (blockType === 'thinking' && typeof block.thinking === 'string') {
          updates.push({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: block.thinking },
            ...(messageId ? { messageId } : {}),
          });
        } else if (blockType === 'tool_use') {
          updates.push(...translateToolUse(block));
        }
      }
      return { updates };
    }

    case 'user': {
      // Tool results arrive as a synthetic user message.
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const toolCallId = String(block.tool_use_id ?? '');
        if (!toolCallId) continue;

        const failed = block.is_error === true;
        const text = flattenToolResult(block.content);
        updates.push({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: failed ? 'failed' : 'completed',
          ...(text ? { content: [{ type: 'content', content: { type: 'text', text } }] } : {}),
        });
      }
      return { updates };
    }

    case 'result': {
      if (event.usage) {
        const used = (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0);
        if (used > 0) updates.push({ sessionUpdate: 'usage_update', used, size: 200_000 });
      }
      return {
        updates,
        stopReason: mapStopReason(event),
        finalText: typeof event.result === 'string' ? event.result : undefined,
        ...(event.usage
          ? {
              usage: {
                inputTokens: event.usage.input_tokens ?? 0,
                outputTokens: event.usage.output_tokens ?? 0,
                costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
                turns: typeof event.num_turns === 'number' ? event.num_turns : null,
              },
            }
          : {}),
      };
    }

    default:
      return { updates };
  }
}

function translateToolUse(block: Record<string, unknown>): SessionUpdate[] {
  const toolCallId = String(block.id ?? '');
  const name = String(block.name ?? 'tool');
  const input = (block.input ?? {}) as Record<string, unknown>;
  if (!toolCallId) return [];

  // TodoWrite is the plan, not a tool call: surface it as an ACP plan update so
  // the editor renders a real checklist instead of an opaque tool invocation.
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    return [{ sessionUpdate: 'plan', entries: translateTodos(input.todos) }];
  }

  const call: SessionUpdate = {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: toolTitle(name, input),
    kind: toolKind(name),
    status: 'in_progress',
    rawInput: input,
  };

  const path = typeof input.file_path === 'string' ? input.file_path : undefined;
  if (path) {
    (call as { locations?: Array<{ path: string }> }).locations = [{ path }];

    // Edits carry a diff so the client can render it inline before completion.
    if (name === 'Write' && typeof input.content === 'string') {
      (call as { content?: ToolCallContent[] }).content = [
        { type: 'diff', path, oldText: null, newText: input.content },
      ];
    } else if (
      (name === 'Edit' || name === 'MultiEdit') &&
      typeof input.old_string === 'string' &&
      typeof input.new_string === 'string'
    ) {
      (call as { content?: ToolCallContent[] }).content = [
        { type: 'diff', path, oldText: input.old_string, newText: input.new_string },
      ];
    }
  }

  return [call];
}

function translateTodos(todos: unknown[]): PlanEntry[] {
  return todos.flatMap((raw): PlanEntry[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const todo = raw as Record<string, unknown>;
    const content = typeof todo.content === 'string' ? todo.content : undefined;
    if (!content) return [];

    const rawStatus = String(todo.status ?? 'pending');
    const status: PlanEntry['status'] =
      rawStatus === 'completed' ? 'completed' : rawStatus === 'in_progress' ? 'in_progress' : 'pending';

    return [{ content, priority: 'medium', status }];
  });
}

/** Tool results are either a plain string or an array of MCP content blocks. */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .filter(Boolean)
    .join('\n');
}

function mapStopReason(event: ClaudeStreamEvent): StopReason {
  if (event.subtype === 'error_max_turns') return 'max_turn_requests';
  if (event.stop_reason === 'max_tokens') return 'max_tokens';
  if (event.stop_reason === 'refusal') return 'refusal';
  return 'end_turn';
}

/**
 * Render one update as a line for a human watching a job.
 *
 * Lives here, next to the translation, so the job log and the ACP surface
 * describe the same event the same way instead of drifting apart.
 * Returns null for updates that have no useful one-line form.
 */
export function describeUpdate(update: SessionUpdate): string | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text' ? update.content.text.trim() || null : null;
    case 'agent_thought_chunk':
      return null; // Thinking is noise in a job log; the ACP client shows it.
    case 'tool_call':
      return `· ${update.title}`;
    case 'tool_call_update':
      return update.status === 'failed' ? `· tool call failed (${update.toolCallId})` : null;
    case 'plan':
      return `· plan: ${update.entries.map((entry) => entry.content).join(' / ')}`;
    default:
      return null;
  }
}

/** Split a byte stream into complete NDJSON lines, buffering partial tails. */
export class NdjsonBuffer {
  private buffer = '';

  push(chunk: string): ClaudeStreamEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The last element is either empty (chunk ended on \n) or a partial line.
    this.buffer = lines.pop() ?? '';

    const events: ClaudeStreamEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as ClaudeStreamEvent);
      } catch {
        // Claude Code must not write non-JSON to stdout, but a truncated or
        // interleaved line should never take the session down.
      }
    }
    return events;
  }
}
