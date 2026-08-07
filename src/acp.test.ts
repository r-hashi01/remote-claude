import assert from 'node:assert/strict';
import { translateEvent, NdjsonBuffer } from './acp.ts';

// 1. init event captures the Claude session id for --resume
{
  const out = translateEvent({ type: 'system', subtype: 'init', session_id: 'abc-123' });
  assert.equal(out.claudeSessionId, 'abc-123');
  assert.equal(out.updates.length, 0);
}

// 2. assistant text -> agent_message_chunk
{
  const out = translateEvent({
    type: 'assistant',
    message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello' }] },
  });
  assert.deepEqual(out.updates, [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' }, messageId: 'msg_1' },
  ]);
}

// 3. thinking -> agent_thought_chunk
{
  const out = translateEvent({
    type: 'assistant',
    message: { id: 'm', content: [{ type: 'thinking', thinking: 'hmm' }] },
  });
  assert.equal(out.updates[0].sessionUpdate, 'agent_thought_chunk');
}

// 4. Edit tool_use -> tool_call with a diff block and location
{
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
  const call = out.updates[0] as any;
  assert.equal(call.sessionUpdate, 'tool_call');
  assert.equal(call.toolCallId, 'toolu_1');
  assert.equal(call.kind, 'edit');
  assert.equal(call.title, 'Edit a.ts');
  assert.deepEqual(call.content, [
    { type: 'diff', path: '/workspace/repo/src/a.ts', oldText: 'a', newText: 'b' },
  ]);
  assert.deepEqual(call.locations, [{ path: '/workspace/repo/src/a.ts' }]);
}

// 5. Bash -> execute kind, command as title
{
  const out = translateEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] },
  });
  const call = out.updates[0] as any;
  assert.equal(call.kind, 'execute');
  assert.equal(call.title, 'npm test');
}

// 6. TodoWrite becomes an ACP plan, not a tool call
{
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
  assert.deepEqual(out.updates, [
    {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read code', priority: 'medium', status: 'completed' },
        { content: 'Fix bug', priority: 'medium', status: 'in_progress' },
      ],
    },
  ]);
}

// 7. tool_result -> tool_call_update, error maps to failed
{
  const ok = translateEvent({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
  });
  assert.equal((ok.updates[0] as any).status, 'completed');

  const bad = translateEvent({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true }] },
  });
  assert.equal((bad.updates[0] as any).status, 'failed');
}

// 8. result -> stopReason + final text
{
  const out = translateEvent({ type: 'result', subtype: 'success', result: 'All done', usage: { input_tokens: 10, output_tokens: 5 } });
  assert.equal(out.stopReason, 'end_turn');
  assert.equal(out.finalText, 'All done');
  assert.deepEqual(out.updates[0], { sessionUpdate: 'usage_update', used: 15, size: 200000 });
}

// 9. max_turns error maps to the ACP stop reason
{
  assert.equal(translateEvent({ type: 'result', subtype: 'error_max_turns' }).stopReason, 'max_turn_requests');
}

// 10. unknown event types are ignored, not fatal
{
  assert.deepEqual(translateEvent({ type: 'rate_limit_event', foo: 1 }).updates, []);
}

// 11. NdjsonBuffer reassembles split lines and skips junk
{
  const buf = new NdjsonBuffer();
  assert.deepEqual(buf.push('{"type":"a"}\n{"ty'), [{ type: 'a' }]);
  assert.deepEqual(buf.push('pe":"b"}\n'), [{ type: 'b' }]);
  assert.deepEqual(buf.push('not json\n'), []);
}

console.log('all translator assertions passed');
