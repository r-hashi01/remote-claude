import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Spindle schema — the single source of truth.
 *
 * Workflow: edit this file, run `npm run db:generate` to emit SQL into
 * migrations/, then `npm run db:migrate` to apply it with wrangler. Nothing
 * hand-writes SQL migrations, so the TypeScript types and the database can
 * never drift.
 *
 * Design notes live in docs/spindle-data-model-v0.1.md. The two that matter
 * most when reading this file:
 *   - tasks.status is a projection derived from `events`, not a user-edited
 *     field. statusReason records why, so the UI can explain a state.
 *   - `events` (raw, audit) and `updates` (curated, user-facing) are separate
 *     tables because many events fold into one update.
 *
 * Timestamps are unix epoch milliseconds.
 */

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  archivedAt: integer('archived_at'),
});

export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('github'),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
    installationId: text('installation_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_repositories_identity').on(
      table.projectId,
      table.provider,
      table.owner,
      table.name
    ),
    index('idx_repositories_project').on(table.projectId),
  ]
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    intent: text('intent'),
    status: text('status', {
      enum: ['to_do', 'in_progress', 'waiting', 'ready_for_review', 'done', 'failed'],
    })
      .notNull()
      .default('to_do'),
    /** Why the task is in this status. Without it the UI cannot explain itself. */
    statusReason: text('status_reason'),
    branch: text('branch'),
    baseBranch: text('base_branch'),
    /** issue | pr | message | manual | error_log */
    originKind: text('origin_kind'),
    originUrl: text('origin_url'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    closedAt: integer('closed_at'),
  },
  (table) => [
    index('idx_tasks_project_status').on(table.projectId, table.status, table.updatedAt),
    index('idx_tasks_updated').on(table.updatedAt),
    index('idx_tasks_branch').on(table.branch),
  ]
);

/** Raw facts. Not shown to users directly; drives status and feeds updates. */
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    source: text('source', { enum: ['github', 'ci', 'slack', 'sandbox', 'user'] }).notNull(),
    kind: text('kind').notNull(),
    /** Idempotency key. Webhook redelivery must not corrupt the state machine. */
    externalId: text('external_id'),
    payload: text('payload', { mode: 'json' }).notNull().default({}),
    occurredAt: integer('occurred_at').notNull(),
    ingestedAt: integer('ingested_at').notNull(),
  },
  (table) => [
    // Partial: events without an external id (e.g. our own sandbox events)
    // are always distinct and must not collide on NULL.
    uniqueIndex('idx_events_external')
      .on(table.source, table.externalId)
      .where(sql`external_id is not null`),
    index('idx_events_task').on(table.taskId, table.occurredAt),
    index('idx_events_project').on(table.projectId, table.occurredAt),
  ]
);

/** Curated, meaningful changes. Separate from events on purpose. */
export const updates = sqliteTable(
  'updates',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    summary: text('summary').notNull(),
    body: text('body'),
    /**
     * action_required | awareness_required | monitoring | noise
     * Internal ranking signal; never surfaced as a label in the UI.
     */
    awareness: text('awareness', {
      enum: ['action_required', 'awareness_required', 'monitoring', 'noise'],
    })
      .notNull()
      .default('awareness_required'),
    sourceUrl: text('source_url'),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
  },
  (table) => [
    index('idx_updates_project').on(table.projectId, table.createdAt),
    index('idx_updates_awareness').on(table.projectId, table.awareness, table.createdAt),
  ]
);

/** Which raw events produced an update — requirement: updates trace to source. */
export const updateEvents = sqliteTable('update_events', {
  updateId: text('update_id')
    .notNull()
    .references(() => updates.id, { onDelete: 'cascade' }),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
});

export const outputs = sqliteTable(
  'outputs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    kind: text('kind', {
      enum: ['pull_request', 'patch', 'investigation', 'test_result', 'deployment', 'report'],
    }).notNull(),
    title: text('title').notNull(),
    status: text('status'),
    url: text('url'),
    /** R2 key. Large bodies never live in D1 — there is a 2 MB row limit. */
    storageKey: text('storage_key'),
    metadata: text('metadata', { mode: 'json' }),
    producedBy: text('produced_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_outputs_project').on(table.projectId, table.createdAt),
    index('idx_outputs_task').on(table.taskId, table.createdAt),
  ]
);

export const connections = sqliteTable(
  'connections',
  {
    id: text('id').primaryKey(),
    /** NULL means account-wide rather than project-scoped. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    externalId: text('external_id').notNull(),
    status: text('status').notNull().default('active'),
    /**
     * Never store credentials here. Secrets live in Cloudflare Secrets; this
     * holds references and non-sensitive settings only.
     */
    config: text('config', { mode: 'json' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('idx_connections_identity').on(table.kind, table.externalId, table.projectId)]
);

export const sandboxRuns = sqliteTable(
  'sandbox_runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /**
     * SandboxProvider.name. Domain state stays independent of the provider,
     * but which provider ran the work must remain auditable.
     */
    provider: text('provider').notNull(),
    externalId: text('external_id'),
    status: text('status', {
      enum: ['creating', 'running', 'paused', 'stopped', 'destroyed', 'failed'],
    })
      .notNull()
      .default('creating'),
    executor: text('executor'),
    /** headCommit + snapshotRef are what a future sandbox needs to resume. */
    headCommit: text('head_commit'),
    snapshotRef: text('snapshot_ref', { mode: 'json' }),
    logKey: text('log_key'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_sandbox_runs_task').on(table.taskId, table.createdAt)]
);
