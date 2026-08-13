/**
 * What a store has to do, stated once for every implementation of it.
 *
 * Several hundred tests run against the in-memory stores in `testing.ts`, which
 * makes them fast and makes them fiction if the real ones behave differently.
 * Nothing checked that. The rules here are the ones the application actually
 * depends on — the order the queue is served in, the order a person reads a list
 * in, what a cursor means — and they run against the fake in node and against
 * Durable Object SQLite in workerd.
 *
 * Only tests import this. It takes a `withStore` rather than a store because the
 * SQLite one exists only inside a Durable Object's context and has to be used
 * within it.
 */

import { describe, expect, test } from 'vitest';
import { Job } from '../domain/job/job';
import type { JobStore, LogStore } from './ports';

export type WithStore<T> = (use: (store: T) => void | Promise<void>) => Promise<void>;

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

export function describeJobStore(name: string, withStore: WithStore<JobStore>): void {
  describe(`${name} as a JobStore`, () => {
    test('returns what it was given', () =>
      withStore((store) => {
        store.save(job('a', { prompt: "it's \"quoted\"\nand has a newline" }));

        const loaded = store.load('a');
        expect(loaded?.id).toBe('a');
        expect(loaded?.toRecord().prompt).toBe("it's \"quoted\"\nand has a newline");
      }));

    test('has nothing to say about a job it never saw', () =>
      withStore((store) => {
        expect(store.load('never')).toBeNull();
      }));

    test('serves the queue oldest first', () =>
      withStore((store) => {
        store.save(job('second', { createdAt: 2_000 }));
        store.save(job('first', { createdAt: 1_000 }));

        expect(store.listQueued().map((one) => one.id)).toEqual(['first', 'second']);
        expect(store.countQueued()).toBe(2);
      }));

    test('lists newest first, because a person is reading it', () =>
      withStore((store) => {
        store.save(job('old', { createdAt: 1_000 }));
        store.save(job('new', { createdAt: 2_000 }));

        expect(store.listRecent(10).map((one) => one.id)).toEqual(['new', 'old']);
      }));

    test('honours the limit it is given', () =>
      withStore((store) => {
        store.save(job('a', { createdAt: 1_000 }));
        store.save(job('b', { createdAt: 2_000 }));

        expect(store.listRecent(1).map((one) => one.id)).toEqual(['b']);
      }));

    test('finds jobs by the statuses asked for', () =>
      withStore((store) => {
        store.save(job('queued'));
        store.save(job('running', { status: 'running' }));
        store.save(job('done', { status: 'completed' }));

        expect(store.listByStatus(['running', 'completed']).map((one) => one.id).sort()).toEqual([
          'done',
          'running',
        ]);
        expect(store.listByStatus([])).toEqual([]);
      }));

    test('reports what is older than a cutoff, for the prune', () =>
      withStore((store) => {
        store.save(job('old', { createdAt: 1_000 }));
        store.save(job('new', { createdAt: 3_000 }));

        expect(store.idsCreatedBefore(2_000)).toEqual(['old']);
      }));

    test('forgets what it removes', () =>
      withStore((store) => {
        store.save(job('a'));
        store.remove('a');

        expect(store.load('a')).toBeNull();
        expect(store.listRecent(10)).toEqual([]);
      }));

    test('overwrites rather than duplicates', () =>
      withStore((store) => {
        store.save(job('a'));
        const running = job('a', { status: 'running' });
        store.save(running);

        expect(store.listRecent(10)).toHaveLength(1);
        expect(store.load('a')?.status).toBe('running');
      }));
  });
}

export function describeLogStore(name: string, withStore: WithStore<LogStore>): void {
  describe(`${name} as a LogStore`, () => {
    test('numbers lines from one, in the order they arrived', () =>
      withStore((store) => {
        store.append('a', 'stdout', 'first');
        store.append('a', 'stderr', 'second');
        store.flush('a');

        const lines = store.read('a', 0, 10);
        expect(lines.map((line) => [line.seq, line.stream, line.line])).toEqual([
          [1, 'stdout', 'first'],
          [2, 'stderr', 'second'],
        ]);
      }));

    // The cursor a follower pages with: `since` is exclusive, or every poll
    // repeats the line it just showed.
    test('reads only what came after the cursor', () =>
      withStore((store) => {
        for (const line of ['a', 'b', 'c']) store.append('job', 'stdout', line);
        store.flush('job');

        expect(store.read('job', 2, 10).map((line) => line.line)).toEqual(['c']);
        expect(store.read('job', 3, 10)).toEqual([]);
      }));

    test('honours the limit it is given', () =>
      withStore((store) => {
        for (const line of ['a', 'b', 'c']) store.append('job', 'stdout', line);
        store.flush('job');

        expect(store.read('job', 0, 2).map((line) => line.line)).toEqual(['a', 'b']);
      }));

    test('keeps one job out of another', () =>
      withStore((store) => {
        store.append('a', 'stdout', 'mine');
        store.append('b', 'stdout', 'theirs');
        store.flush('a');
        store.flush('b');

        expect(store.read('a', 0, 10).map((line) => line.line)).toEqual(['mine']);
        expect(store.read('b', 0, 10).map((line) => line.line)).toEqual(['theirs']);
      }));

    test('forgets a job it was told to forget', () =>
      withStore((store) => {
        store.append('a', 'stdout', 'mine');
        store.flush('a');
        store.removeFor('a');

        expect(store.read('a', 0, 10)).toEqual([]);
      }));
  });
}
