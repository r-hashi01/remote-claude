import { describe, expect, test } from 'vitest';
import { FakeJobGateway } from './testing.js';

/**
 * Knowing whether a page is the end, and being able to ask for it.
 *
 * A job died at `install` with `npm error ECONNRESET` and a consumer reported it as
 * ending in "lint ok": it read one page, and a full page and a final page were the
 * same answer. The cause was on the page nobody fetched.
 */
describe('paging a log', () => {
  function withLines(count: number): FakeJobGateway {
    const gateway = new FakeJobGateway();
    gateway.lines = Array.from({ length: count }, (_, index) => ({
      seq: index + 1,
      ts: index,
      stream: 'stdout' as const,
      line: `line ${index + 1}`,
    }));
    return gateway;
  }

  test('says there is more when there is', async () => {
    const gateway = withLines(10);
    // The fake pages in fives, as the executor pages in thousands.
    const page = await gateway.logs('job-1', 0);

    expect(page.hasMore).toBe(page.nextSince < 10);
  });

  test('hands back the end when asked for it', async () => {
    const gateway = withLines(10);

    const tail = await gateway.logTail('job-1', 3);

    expect(tail.logs.map((line) => line.line)).toEqual(['line 8', 'line 9', 'line 10']);
    expect(tail.hasMore).toBe(false);
  });
});
