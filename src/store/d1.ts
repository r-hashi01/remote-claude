import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';
import type {
  Awareness,
  DomainEvent,
  NewEvent,
  NewOutput,
  NewProject,
  NewRepository,
  NewSandboxRun,
  NewTask,
  NewUpdate,
  Output,
  Project,
  Repository,
  SandboxRun,
  SandboxRunPatch,
  SpindleStore,
  Task,
  TaskPatch,
  TaskStatus,
  Update,
} from './types';

/**
 * D1 implementation of SpindleStore.
 *
 * Every query goes through Drizzle, which emits parameterised statements — no
 * value is ever concatenated into SQL. Column names and types are checked
 * against src/store/schema.ts at compile time.
 *
 * Note on transactions: D1 has no interactive transactions, only `batch()`.
 * Anything needing read-then-write atomicity must be expressed as an idempotent
 * write or guarded with a version check, not wrapped in a transaction. The
 * store interface deliberately exposes no `transaction()` so callers cannot
 * assume one exists and be surprised on Postgres later.
 */
type Db = DrizzleD1Database<typeof schema>;

const first = <T>(rows: T[]): T | null => rows[0] ?? null;
const id = () => crypto.randomUUID();
const now = () => Date.now();

export function createD1Store(database: D1Database): SpindleStore {
  const db = drizzle(database, { schema });
  return {
    projects: projectStore(db),
    repositories: repositoryStore(db),
    tasks: taskStore(db),
    events: eventStore(db),
    updates: updateStore(db),
    outputs: outputStore(db),
    sandboxRuns: sandboxRunStore(db),
  };
}

// ---------------------------------------------------------------- projects

function projectStore(db: Db) {
  return {
    async create(input: NewProject): Promise<Project> {
      const timestamp = now();
      const row = {
        id: id(),
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
      };
      await db.insert(schema.projects).values(row);
      return row;
    },

    async get(projectId: string): Promise<Project | null> {
      return first(await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)));
    },

    async getBySlug(slug: string): Promise<Project | null> {
      return first(await db.select().from(schema.projects).where(eq(schema.projects.slug, slug)));
    },

    async list(options: { limit?: number; includeArchived?: boolean } = {}): Promise<Project[]> {
      const query = db.select().from(schema.projects).orderBy(desc(schema.projects.updatedAt));
      const rows = await query.limit(options.limit ?? 50);
      return options.includeArchived ? rows : rows.filter((p) => p.archivedAt === null);
    },
  };
}

// ------------------------------------------------------------ repositories

function repositoryStore(db: Db) {
  return {
    async create(input: NewRepository): Promise<Repository> {
      const row = {
        id: id(),
        projectId: input.projectId,
        provider: input.provider ?? 'github',
        owner: input.owner,
        name: input.name,
        defaultBranch: input.defaultBranch,
        isPrimary: input.isPrimary ?? false,
        installationId: input.installationId ?? null,
        createdAt: now(),
      };
      await db.insert(schema.repositories).values(row);
      return row;
    },

    async listByProject(projectId: string): Promise<Repository[]> {
      return db.select().from(schema.repositories).where(eq(schema.repositories.projectId, projectId));
    },

    async getPrimary(projectId: string): Promise<Repository | null> {
      const rows = await db
        .select()
        .from(schema.repositories)
        .where(
          and(eq(schema.repositories.projectId, projectId), eq(schema.repositories.isPrimary, true))
        );
      // Fall back to any repository so a project with one un-flagged repo works.
      return first(rows) ?? first(await this.listByProject(projectId));
    },
  };
}

// ------------------------------------------------------------------- tasks

function taskStore(db: Db) {
  return {
    async create(input: NewTask): Promise<Task> {
      const timestamp = now();
      const row = {
        id: id(),
        projectId: input.projectId,
        repositoryId: input.repositoryId ?? null,
        title: input.title,
        intent: input.intent ?? null,
        status: input.status ?? ('to_do' as TaskStatus),
        statusReason: input.statusReason ?? null,
        branch: input.branch ?? null,
        baseBranch: input.baseBranch ?? null,
        originKind: input.originKind ?? null,
        originUrl: input.originUrl ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        closedAt: input.closedAt ?? null,
      };
      await db.insert(schema.tasks).values(row);
      return row;
    },

    async get(taskId: string): Promise<Task | null> {
      return first(await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)));
    },

    async patch(taskId: string, changes: TaskPatch): Promise<Task | null> {
      const rows = await db
        .update(schema.tasks)
        .set({ ...changes, updatedAt: now() })
        .where(eq(schema.tasks.id, taskId))
        .returning();
      return first(rows);
    },

    async listByProject(
      projectId: string,
      options: { statuses?: TaskStatus[]; limit?: number } = {}
    ): Promise<Task[]> {
      const where = options.statuses?.length
        ? and(eq(schema.tasks.projectId, projectId), inArray(schema.tasks.status, options.statuses))
        : eq(schema.tasks.projectId, projectId);

      return db
        .select()
        .from(schema.tasks)
        .where(where)
        .orderBy(desc(schema.tasks.updatedAt))
        .limit(options.limit ?? 100);
    },

    async listRecent(limit = 20): Promise<Task[]> {
      return db.select().from(schema.tasks).orderBy(desc(schema.tasks.updatedAt)).limit(limit);
    },

    async findByBranch(branch: string): Promise<Task | null> {
      const rows = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.branch, branch))
        .orderBy(desc(schema.tasks.createdAt))
        .limit(1);
      return first(rows);
    },
  };
}

// ------------------------------------------------------------------ events

function eventStore(db: Db) {
  return {
    async append(input: NewEvent): Promise<DomainEvent> {
      const timestamp = now();
      const row = {
        id: id(),
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        source: input.source,
        kind: input.kind,
        externalId: input.externalId ?? null,
        payload: input.payload ?? {},
        occurredAt: input.occurredAt ?? timestamp,
        ingestedAt: timestamp,
      };

      // Redelivered webhooks must not double-apply. The partial unique index on
      // (source, external_id) makes this a no-op for a duplicate.
      await db.insert(schema.events).values(row).onConflictDoNothing();

      if (!row.externalId) return row;

      const existing = await db
        .select()
        .from(schema.events)
        .where(
          and(eq(schema.events.source, row.source), eq(schema.events.externalId, row.externalId))
        )
        .limit(1);
      return first(existing) ?? row;
    },

    async listByTask(taskId: string, limit = 100): Promise<DomainEvent[]> {
      return db
        .select()
        .from(schema.events)
        .where(eq(schema.events.taskId, taskId))
        .orderBy(desc(schema.events.occurredAt))
        .limit(limit);
    },
  };
}

// ----------------------------------------------------------------- updates

function updateStore(db: Db) {
  return {
    async create(input: NewUpdate, fromEventIds: string[] = []): Promise<Update> {
      const row = {
        id: id(),
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        summary: input.summary,
        body: input.body ?? null,
        awareness: input.awareness ?? ('awareness_required' as Awareness),
        sourceUrl: input.sourceUrl ?? null,
        createdAt: now(),
        readAt: null,
      };

      const writes: Parameters<Db['batch']>[0][number][] = [
        db.insert(schema.updates).values(row),
      ];
      if (fromEventIds.length > 0) {
        writes.push(
          db
            .insert(schema.updateEvents)
            .values(fromEventIds.map((eventId) => ({ updateId: row.id, eventId })))
        );
      }
      // batch() is the closest D1 gets to atomicity — see the note at the top.
      await db.batch(writes as [(typeof writes)[number], ...typeof writes]);

      return row;
    },

    async listByProject(
      projectId: string,
      options: { limit?: number; awareness?: Awareness[] } = {}
    ): Promise<Update[]> {
      const where = options.awareness?.length
        ? and(
            eq(schema.updates.projectId, projectId),
            inArray(schema.updates.awareness, options.awareness)
          )
        : eq(schema.updates.projectId, projectId);

      return db
        .select()
        .from(schema.updates)
        .where(where)
        .orderBy(desc(schema.updates.createdAt))
        .limit(options.limit ?? 50);
    },

    async markRead(updateId: string): Promise<void> {
      await db
        .update(schema.updates)
        .set({ readAt: now() })
        .where(eq(schema.updates.id, updateId));
    },
  };
}

// ----------------------------------------------------------------- outputs

function outputStore(db: Db) {
  return {
    async create(input: NewOutput): Promise<Output> {
      const row = {
        id: id(),
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        kind: input.kind,
        title: input.title,
        status: input.status ?? null,
        url: input.url ?? null,
        storageKey: input.storageKey ?? null,
        metadata: input.metadata ?? null,
        producedBy: input.producedBy,
        createdAt: now(),
      };
      await db.insert(schema.outputs).values(row);
      return row;
    },

    async listByProject(projectId: string, limit = 50): Promise<Output[]> {
      return db
        .select()
        .from(schema.outputs)
        .where(eq(schema.outputs.projectId, projectId))
        .orderBy(desc(schema.outputs.createdAt))
        .limit(limit);
    },

    async listByTask(taskId: string): Promise<Output[]> {
      return db
        .select()
        .from(schema.outputs)
        .where(eq(schema.outputs.taskId, taskId))
        .orderBy(desc(schema.outputs.createdAt));
    },
  };
}

// ------------------------------------------------------------ sandbox runs

function sandboxRunStore(db: Db) {
  return {
    async create(input: NewSandboxRun): Promise<SandboxRun> {
      const row = {
        id: id(),
        taskId: input.taskId,
        provider: input.provider,
        externalId: input.externalId ?? null,
        status: input.status ?? ('creating' as SandboxRun['status']),
        executor: input.executor ?? null,
        headCommit: null,
        snapshotRef: null,
        logKey: null,
        startedAt: null,
        endedAt: null,
        createdAt: now(),
      };
      await db.insert(schema.sandboxRuns).values(row);
      return row;
    },

    async patch(runId: string, changes: SandboxRunPatch): Promise<void> {
      await db.update(schema.sandboxRuns).set(changes).where(eq(schema.sandboxRuns.id, runId));
    },

    async listByTask(taskId: string): Promise<SandboxRun[]> {
      return db
        .select()
        .from(schema.sandboxRuns)
        .where(eq(schema.sandboxRuns.taskId, taskId))
        .orderBy(desc(schema.sandboxRuns.createdAt));
    },
  };
}
