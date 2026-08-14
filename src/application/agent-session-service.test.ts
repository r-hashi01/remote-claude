import { describe, expect, test } from 'vitest';
import { AgentSessionService, type AgentSessionDeps } from './agent-session-service';
import type { ExecutorPolicy } from './ports';
import {
  AllowAllGitHub,
  DenyAllGitHub,
  FakeSandboxProvider,
  ImmediateBackground,
  InMemorySessionStore,
  RecordingUpdateSink,
} from './testing';

const CONFIGURED_REPO = 'https://github.com/r-hashi01/spindle.git';
const SANDBOX_ID = 'acp-test';
const SESSION_ID = 's-1';

function policy(overrides: Partial<ExecutorPolicy> = {}): ExecutorPolicy {
  return {
    repoUrl: CONFIGURED_REPO,
    defaultBaseBranch: 'main',
    allowCustomRepo: true,
    allowPush: false,
    maxConcurrency: 2,
    jobTimeoutMs: 30 * 60 * 1000,
    claudeTimeoutMs: 25 * 60 * 1000,
    heartbeatTimeoutMs: 90_000,
    stallTimeoutMs: 8 * 60 * 1000,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    sleepAfter: '2m',
    commands: { install: '', lint: '', test: '', build: '' },
    claudeAuthScheme: 'subscription',
    ...overrides,
  };
}

interface Harness {
  service: AgentSessionService;
  session: InMemorySessionStore;
  updates: RecordingUpdateSink;
  sandboxes: FakeSandboxProvider;
  background: ImmediateBackground;
}

function harness(overrides: Partial<AgentSessionDeps> = {}): Harness {
  const session = new InMemorySessionStore();
  const updates = new RecordingUpdateSink();
  const sandboxes = new FakeSandboxProvider();
  const background = new ImmediateBackground();

  const deps: AgentSessionDeps = {
    policy: policy(),
    sandboxes,
    sandboxId: SANDBOX_ID,
    session,
    updates,
    github: new AllowAllGitHub(),
    redact: (input) => input,
    background,
    claudeEnvironment: () => ({}),
    ...overrides,
  };

  return { service: new AgentSessionService(deps), session, updates, sandboxes, background };
}

interface RecordedNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

function notifications(updates: RecordingUpdateSink): RecordedNotification[] {
  return updates.messages as RecordedNotification[];
}

/** Wait for one macrotask, letting every microtask chain queued so far settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** One line of Claude Code's stream-json, as `NdjsonBuffer`/`translateEvent` expect it. */
function initLine(claudeSessionId: string): string {
  return JSON.stringify({ type: 'system', subtype: 'init', session_id: claudeSessionId });
}

function assistantTextLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function resultLine(): string {
  return JSON.stringify({ type: 'result' });
}

describe('start()', () => {
  test('without a repo, uses the configured one and never checks reachability', async () => {
    const github = new AllowAllGitHub();
    const { service } = harness({ github });

    const result = await service.start({});

    expect(result).toEqual({ repo: CONFIGURED_REPO, baseBranch: 'main' });
    expect(github.checked).toEqual([]);
  });

  test('a custom repo, when this deployment allows one, is checked for reachability', async () => {
    const github = new AllowAllGitHub();
    const { service } = harness({ github });

    const result = await service.start({ repo: 'https://github.com/other/thing.git' });

    expect(result.repo).toBe('https://github.com/other/thing.git');
    expect(github.checked).toEqual(['https://github.com/other/thing.git']);
  });

  test('a custom repo, when this deployment forbids one, is refused with the same wording as a job', async () => {
    const { service } = harness({ policy: policy({ allowCustomRepo: false }) });

    await expect(service.start({ repo: 'https://github.com/other/thing.git' })).rejects.toThrow(
      /pinned to .*spindle.* will not run against .*other\/thing.*disabled on the executor/s
    );
  });

  test('a repo the installation cannot reach fails start(), before any turn runs', async () => {
    const { service, session } = harness({
      github: new DenyAllGitHub('installation cannot reach other/thing'),
    });

    await expect(service.start({ repo: 'https://github.com/other/thing.git' })).rejects.toThrow(
      /cannot reach other\/thing/
    );
    // Nothing was recorded, so a later prompt() would fall back to the configured repo.
    expect(session.load()).toEqual({});
  });
});

describe('a turn', () => {
  test("echoes the user's message as a user_message_chunk update", async () => {
    const { service, sandboxes, updates, background } = harness();
    await service.start({});
    sandboxes.get(SANDBOX_ID).script({ stdout: [resultLine()] });

    await service.prompt(SESSION_ID, 'fix the bug');
    await background.settle();

    const userChunk = notifications(updates).find(
      (m) => m.method === 'session/update' && (m.params.update as { sessionUpdate?: string }).sessionUpdate === 'user_message_chunk'
    );
    expect(userChunk?.params.update).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'fix the bug' },
    });
  });

  test('clones the repository once; a second turn does not clone again', async () => {
    const { service, sandboxes, background } = harness();
    await service.start({});
    const sandbox = sandboxes.get(SANDBOX_ID);
    sandbox.script({ stdout: [resultLine()] }, { stdout: [resultLine()] });

    await service.prompt(SESSION_ID, 'first turn');
    await background.settle();
    expect(sandbox.cloneCount).toBe(1);
    expect(sandbox.cloned).toEqual({ repo: CONFIGURED_REPO, branch: 'main' });

    await service.prompt(SESSION_ID, 'second turn');
    await background.settle();
    expect(sandbox.cloneCount).toBe(1);
  });

  test("remembers the init event's session id and resumes with it on the next turn", async () => {
    const { service, sandboxes, background } = harness();
    await service.start({});
    const sandbox = sandboxes.get(SANDBOX_ID);

    sandbox.script({ stdout: [initLine('claude-session-abc'), resultLine()] });
    await service.prompt(SESSION_ID, 'first turn');
    await background.settle();

    sandbox.script({ stdout: [resultLine()] });
    await service.prompt(SESSION_ID, 'second turn');
    await background.settle();

    expect(sandbox.commands.at(-1)).toContain("--resume 'claude-session-abc'");
  });

  test("translates the agent's stdout into session/update notifications", async () => {
    const { service, sandboxes, updates, background } = harness();
    await service.start({});
    sandboxes.get(SANDBOX_ID).script({ stdout: [assistantTextLine('hello from claude'), resultLine()] });

    await service.prompt(SESSION_ID, 'say hi');
    await background.settle();

    const agentChunk = notifications(updates).find(
      (m) => m.method === 'session/update' && (m.params.update as { sessionUpdate?: string }).sessionUpdate === 'agent_message_chunk'
    );
    expect(agentChunk?.params.update).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello from claude' },
      messageId: 'msg-1',
    });
  });

  test('emits _remoteClaude/turnEnd with a stop reason when the turn finishes normally', async () => {
    const { service, sandboxes, updates, background } = harness();
    await service.start({});
    sandboxes.get(SANDBOX_ID).script({ stdout: [resultLine()] });

    await service.prompt(SESSION_ID, 'do it');
    await background.settle();

    const turnEnd = notifications(updates).find((m) => m.method === '_remoteClaude/turnEnd');
    expect(turnEnd?.params).toEqual({ sessionId: SESSION_ID, stopReason: 'end_turn' });
  });

  test('a second prompt() while one is in flight is rejected', async () => {
    const { service, sandboxes, background } = harness();
    await service.start({});
    sandboxes.get(SANDBOX_ID).script({ stdout: [resultLine()] });

    await service.prompt(SESSION_ID, 'first');
    await expect(service.prompt(SESSION_ID, 'second')).rejects.toThrow(/a turn is already in flight/);

    await background.settle();
  });

  test('cancel() kills the sandbox process and ends the turn with stopReason "cancelled"', async () => {
    const { service, sandboxes, updates, background } = harness();
    await service.start({});
    const sandbox = sandboxes.get(SANDBOX_ID);
    sandbox.script({ hang: true });

    await service.prompt(SESSION_ID, 'do something long');
    // Let the turn reach the sandbox.exec() call and register its abort race
    // before cancelling — mirrors a real cancel arriving mid-turn rather than
    // before the turn has even started talking to the sandbox.
    await tick();

    service.cancel();
    await background.settle();

    expect(sandbox.killed).toBe(true);
    const turnEnd = notifications(updates).find((m) => m.method === '_remoteClaude/turnEnd');
    expect(turnEnd?.params).toEqual({ sessionId: SESSION_ID, stopReason: 'cancelled' });
  });
});

describe('close()', () => {
  test('destroys the sandbox and clears the session store', async () => {
    const { service, sandboxes, session } = harness();
    await service.start({});
    const sandbox = sandboxes.get(SANDBOX_ID);

    await service.close();

    expect(sandbox.destroyed).toBe(true);
    expect(session.load()).toEqual({});
  });
});
