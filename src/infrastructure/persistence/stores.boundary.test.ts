import { beforeEach, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Job } from '../../domain/job/job';
import {
  migrate,
  SqliteJobStore,
  SqliteLedgerStore,
  SqliteLogStore,
} from './sqlite-stores';
import { R2ArtifactStore } from './r2-artifact-store';
import {
  describeJobStore,
  describeLogPaging,
  describeLogStore,
} from '../../application/store-contract';

/**
 * The stores, against the storage they were written for.
 *
 * These three files had no tests. Everything above them is covered by fakes that
 * hold records in a Map — which is faithful to the *rules* and says nothing about
 * the parts that only exist here: a bound-parameter ceiling per statement, JSON in
 * a TEXT column, the ordering a query promises, and storage carried over from when
 * this object had another name.
 *
 * `runInDurableObject` gives the real SqlStorage of a real object, so what runs is
 * SQLite rather than a description of it.
 */
async function inStorage<T>(run: (sql: SqlStorage) => T | Promise<T>): Promise<T> {
  const stub = env.JOBS.get(env.JOBS.idFromName('stores-under-test'));
  return runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
    migrate(state.storage.sql);
    return run(state.storage.sql);
  });
}

function job(id: string, overrides: Record<string, unknown> = {}): Job {
  return Job.fromRecord({
    id,
    status: 'queued',
    prompt: 'x',
    repo: 'https://github.com/o/r.git',
    baseBranch: 'main',
    branch: `claude/${id}`,
    createdAt: 1_000,
    options: {},
    ...overrides,
  } as never);
}

/**
 * The storage of an earlier incarnation of this object.
 *
 * Renaming a Durable Object class carries its SQLite over, so this object still
 * held the tables from when it was TaskManager — whose `logs` was keyed by
 * `task_id`. `CREATE TABLE IF NOT EXISTS` leaves that in place without complaint,
 * and then every insert fails with "no such column: job_id". This is the only
 * place that history can be re-created: fakes have no schema to be wrong.
 */
describe('storage inherited from when this object had another name', () => {
  it('rebuilds a logs table keyed by the old column', async () => {
    const stub = env.JOBS.get(env.JOBS.idFromName('legacy-storage'));
    const lines = await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      const sql = state.storage.sql;
      // TaskManager's schema, as it would have been carried forward.
      sql.exec(`
        CREATE TABLE logs (
          task_id TEXT NOT NULL,
          seq     INTEGER NOT NULL,
          ts      INTEGER NOT NULL,
          stream  TEXT NOT NULL,
          line    TEXT NOT NULL
        );
      `);
      sql.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)');
      sql.exec("INSERT INTO logs VALUES ('t1', 1, 1, 'stdout', 'from the old world')");

      migrate(sql);

      // Logs are short-lived, so the old rows are not migrated — but writing has
      // to work, which it does not if the table was left as it was.
      const store = new SqliteLogStore(sql);
      store.append('a', 'stdout', 'from the new one');
      store.flush('a');
      return store.read('a', 0, 10).map((line) => line.line);
    });

    expect(lines).toEqual(['from the new one']);
  });

  it('drops the tables that belonged to the product side', async () => {
    const stub = env.JOBS.get(env.JOBS.idFromName('legacy-tables'));
    const remaining = await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      const sql = state.storage.sql;
      sql.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)');
      sql.exec('CREATE TABLE artifacts (id TEXT PRIMARY KEY)');

      migrate(sql);

      return sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
        .filter((name) => name === 'tasks' || name === 'artifacts');
    });

    expect(remaining).toEqual([]);
  });
});

describe('the job store', () => {
  it('returns a record through a TEXT column unchanged', async () => {
    const loaded = await inStorage((sql) => {
      const store = new SqliteJobStore(sql);
      // The shapes that make JSON-in-SQL worth checking: nested objects, a long
      // body, and the quotes and newlines a diffstat and a prompt really contain.
      store.save(
        job('a', {
          prompt: "it's a prompt\nwith a newline and a 'quote'",
          result: {
            changed: true,
            branch: 'claude/a',
            pushed: false,
            claudeOutput: 'x'.repeat(50_000),
            gitStatus: '## claude/a',
            diffStat: ' a | 1 +',
            diffBytes: 8,
            steps: [
              { name: 'install', command: 'npm ci', exitCode: 0, success: true, durationMs: 1, output: '' },
            ],
          },
          workspace: { provider: 'cloudflare', id: 'snap-1', dir: '/workspace' },
        })
      );
      return store.load('a')?.toRecord();
    });

    expect(loaded?.prompt).toBe("it's a prompt\nwith a newline and a 'quote'");
    expect(loaded?.result?.claudeOutput).toHaveLength(50_000);
    expect(loaded?.result?.steps?.[0]?.name).toBe('install');
    expect(loaded?.workspace).toEqual({ provider: 'cloudflare', id: 'snap-1', dir: '/workspace' });
  });

  it('answers the queries the executor schedules from', async () => {
    const answers = await inStorage((sql) => {
      const store = new SqliteJobStore(sql);
      store.save(job('old', { createdAt: 1_000 }));
      store.save(job('new', { createdAt: 3_000 }));
      store.save(job('running', { createdAt: 2_000, status: 'running' }));

      return {
        // Oldest first: the queue is served in the order it was joined.
        queued: store.listQueued().map((one) => one.id),
        // Newest first: a list is read by a person.
        recent: store.listRecent(10).map((one) => one.id),
        byStatus: store.listByStatus(['running']).map((one) => one.id),
        counted: store.countQueued(),
        prunable: store.idsCreatedBefore(2_500).sort(),
      };
    });

    expect(answers.queued).toEqual(['old', 'new']);
    expect(answers.recent).toEqual(['new', 'running', 'old']);
    expect(answers.byStatus).toEqual(['running']);
    expect(answers.counted).toBe(2);
    expect(answers.prunable).toEqual(['old', 'running']);
  });

  it('forgets a job it was told to remove', async () => {
    const after = await inStorage((sql) => {
      const store = new SqliteJobStore(sql);
      store.save(job('a'));
      store.remove('a');
      return store.load('a');
    });
    expect(after).toBeNull();
  });
});

describe('the log store', () => {
  /**
   * The ceiling this file exists to respect: 100 bound parameters per statement,
   * five columns a row. Chunking wrong throws "too many SQL variables" and takes
   * the whole batch of lines with it — quietly, since logs are reporting on the
   * job rather than part of it. A count no chunk size divides evenly.
   */
  it('writes more lines in one flush than a statement can bind', async () => {
    const lines = await inStorage((sql) => {
      const store = new SqliteLogStore(sql);
      for (let i = 1; i <= 137; i += 1) store.append('a', 'stdout', `line ${i}`);
      store.flush('a');
      return store.read('a', 0, 500);
    });

    expect(lines).toHaveLength(137);
    expect(lines[0]?.line).toBe('line 1');
    expect(lines.at(-1)?.line).toBe('line 137');
    // Sequence numbers are the cursor a follower pages with; gaps would repeat or
    // skip lines for every client at once.
    expect(lines.map((line) => line.seq)).toEqual(
      Array.from({ length: 137 }, (_, index) => index + 1)
    );
  });

  it('reads only what came after the cursor', async () => {
    const page = await inStorage((sql) => {
      const store = new SqliteLogStore(sql);
      for (const line of ['a', 'b', 'c']) store.append('a', 'stdout', line);
      store.flush('a');
      return store.read('a', 2, 10);
    });

    expect(page.map((line) => line.line)).toEqual(['c']);
  });

  it('keeps one job\'s lines out of another\'s', async () => {
    const both = await inStorage((sql) => {
      const store = new SqliteLogStore(sql);
      store.append('a', 'stdout', 'mine');
      store.append('b', 'stdout', 'theirs');
      store.flush('a');
      store.flush('b');
      store.removeFor('b');
      return { a: store.read('a', 0, 10).map((l) => l.line), b: store.read('b', 0, 10) };
    });

    expect(both.a).toEqual(['mine']);
    expect(both.b).toEqual([]);
  });
});

describe('the sandbox ledger', () => {
  it('tells the sweep which sandboxes were never given back', async () => {
    const state = await inStorage((sql) => {
      const store = new SqliteLedgerStore(sql);
      store.record('rc-a', 'a', 1_000);
      store.record('rc-b', 'b', 1_000);
      store.countTeardownAttempt('rc-b');
      store.markTeardownError('rc-b', 'container unavailable');
      store.markDestroyed('rc-a', 2_000);

      return { outstanding: store.outstandingJobIds(), entries: store.list(10) };
    });

    expect(state.outstanding).toEqual(['b']);
    const b = state.entries.find((entry) => entry.id === 'rc-b');
    expect(b?.attempts).toBe(1);
    expect(b?.lastError).toBe('container unavailable');
    // Reclaiming clears the error with it: a sandbox that came back is not a
    // sandbox with a problem.
    const a = state.entries.find((entry) => entry.id === 'rc-a');
    expect(a?.destroyedAt).toBe(2_000);
    expect(a?.lastError).toBeNull();
  });
});

describe('the artifact store', () => {
  beforeEach(async () => {
    const listed = await env.ARTIFACTS.list();
    await Promise.all(listed.objects.map((object) => env.ARTIFACTS.delete(object.key)));
  });

  /**
   * Why R2 at all: a patch has no size bound and a D1 row does. This is the size
   * that would not have fitted.
   */
  it('carries a patch too large for a database row', async () => {
    const store = new R2ArtifactStore(env.ARTIFACTS);
    const patch = `diff --git a/a b/a\n${'+line\n'.repeat(400_000)}`;
    expect(patch.length).toBeGreaterThan(2_000_000);

    await store.putPatch('a', patch);

    expect(await store.getPatch('a')).toBe(patch);
  });

  it('answers null for a job that produced no patch', async () => {
    const store = new R2ArtifactStore(env.ARTIFACTS);
    expect(await store.getPatch('never-ran')).toBeNull();
  });
});

/**
 * The same contract the fakes are held to, against Durable Object SQLite.
 *
 * Several hundred tests run against the in-memory stores. That makes them fast,
 * and makes them fiction if the real ones behave differently — which nothing
 * checked. Same words, both implementations.
 */
describeJobStore('the SQLite store', (use) => inStorage((sql) => use(new SqliteJobStore(sql))));
describeLogStore('the SQLite store', (use) => inStorage((sql) => use(new SqliteLogStore(sql))));

describeLogPaging('the SQLite store', (use) => inStorage((sql) => use(new SqliteLogStore(sql))));
