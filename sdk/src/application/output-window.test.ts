import { describe, expect, test } from 'vitest';
import { FakeJobGateway } from './testing.js';

/**
 * Reading a window of output, rather than following it.
 *
 * `followOutput` holds a connection open; this answers once. Both exist because
 * they are asked by different things — a page being rendered on a server has no
 * connection to hold, and a check on what a run said does not want one.
 */
describe('one window of output', () => {
  test('returns the bytes at the offset and where to continue', async () => {
    const gateway = new FakeJobGateway();
    gateway.outputText = '▶ install\nadded 101 packages\n';

    const first = await gateway.output('job-1', 0, 12);

    expect(first.text).toBe('▶ install\n');
    // Bytes, not characters: `▶` is three of them, and conflating the two
    // duplicated output the first time this was measured live.
    expect(first.nextOffset).toBe(12);
    expect(first.size).toBe(new TextEncoder().encode(gateway.outputText).length);
  });

  test('continues exactly where the last one stopped', async () => {
    const gateway = new FakeJobGateway();
    gateway.outputText = 'first\nsecond\n';

    const first = await gateway.output('job-1', 0, 6);
    const second = await gateway.output('job-1', first.nextOffset, 100);

    expect(first.text + second.text).toBe('first\nsecond\n');
  });

  test('says whether more can arrive', async () => {
    const gateway = new FakeJobGateway();
    gateway.states = [{ status: 'running' } as never];
    expect((await gateway.output('job-1', 0)).done).toBe(false);

    gateway.states = [{ status: 'completed' } as never];
    expect((await gateway.output('job-1', 0)).done).toBe(true);
  });
});
