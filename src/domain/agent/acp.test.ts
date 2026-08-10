import { describe, expect, test } from 'vitest';
import { NdjsonBuffer, translateEvent } from './acp';

/**
 * The translator is the one place where Claude Code's event stream is given
 * meaning — both the job log and the ACP session surface read it through here
 * — so its cases are pinned rather than eyeballed.
 */

describe('translateEvent', () => {
  test('the init event carries the session id used for --resume', () => {
    const out = translateEvent({ type: 'system', subtype: 'init', session_id: 'abc-123' });
    expect(out.claudeSessionId).toBe('abc-123');
    expect(out.updates).toHaveLength(0);
  });

  test('assistant text becomes a message chunk', () => {
    const out = translateEvent({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello' }] },
    });
    expect(out.updates).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
        messageId: 'msg_1',
      },
    ]);
  });

  test('thinking becomes a thought chunk', () => {
    const out = translateEvent({
      type: 'assistant',
      message: { id: 'm', content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    expect(out.updates[0]?.sessionUpdate).toBe('agent_thought_chunk');
  });

  test('an Edit becomes a tool call with a diff block and a location', () => {
    const out = translateEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Edit',
            input: { file_path: '/workspace/repo/src/a.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
    });

    expect(out.updates[0]).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_1',
      kind: 'edit',
      title: 'Edit a.ts',
      content: [{ type: 'diff', path: '/workspace/repo/src/a.ts', oldText: 'a', newText: 'b' }],
      locations: [{ path: '/workspace/repo/src/a.ts' }],
    });
  });

  test('a Bash call is an execute, titled with the command', () => {
    const out = translateEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }],
      },
    });
    expect(out.updates[0]).toMatchObject({ kind: 'execute', title: 'npm test' });
  });

  test('TodoWrite becomes a plan rather than a tool call', () => {
    const out = translateEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't3',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Read code', status: 'completed' },
                { content: 'Fix bug', status: 'in_progress' },
              ],
            },
          },
        ],
      },
    });

    expect(out.updates).toEqual([
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read code', priority: 'medium', status: 'completed' },
          { content: 'Fix bug', priority: 'medium', status: 'in_progress' },
        ],
      },
    ]);
  });

  test('a tool result updates the call, and an error result fails it', () => {
    const ok = translateEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
    });
    expect(ok.updates[0]).toMatchObject({ status: 'completed' });

    const bad = translateEvent({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
        ],
      },
    });
    expect(bad.updates[0]).toMatchObject({ status: 'failed' });
  });

  test('the result event carries the stop reason, the closing text and usage', () => {
    const out = translateEvent({
      type: 'result',
      subtype: 'success',
      result: 'All done',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(out.stopReason).toBe('end_turn');
    expect(out.finalText).toBe('All done');
    expect(out.updates[0]).toEqual({ sessionUpdate: 'usage_update', used: 15, size: 200_000 });
  });

  test('running out of turns maps to the ACP stop reason', () => {
    expect(translateEvent({ type: 'result', subtype: 'error_max_turns' }).stopReason).toBe(
      'max_turn_requests'
    );
  });

  // The event stream gains members over time; an unknown one must never take a
  // job down.
  test('unknown event types are ignored rather than fatal', () => {
    expect(translateEvent({ type: 'rate_limit_event', foo: 1 }).updates).toEqual([]);
  });
});

describe('NdjsonBuffer', () => {
  test('reassembles a line split across chunks and skips junk', () => {
    const buffer = new NdjsonBuffer();
    expect(buffer.push('{"type":"a"}\n{"ty')).toEqual([{ type: 'a' }]);
    expect(buffer.push('pe":"b"}\n')).toEqual([{ type: 'b' }]);
    expect(buffer.push('not json\n')).toEqual([]);
  });
});
