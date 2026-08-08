import type * as schema from './schema';

/**
 * Spindle domain types and the store interface.
 *
 * Row types are *derived* from the Drizzle schema rather than restated here,
 * so a column rename is a compile error at every call site instead of a
 * runtime surprise. Only the store contract is hand-written.
 *
 * Everything above this file works in these types and never sees SQL, a D1
 * binding, or a column name — swapping D1 for Postgres later (see the
 * migration triggers in docs/spindle-data-model-v0.1.md) means adding one
 * implementation, not touching callers.
 *
 * Timestamps are unix epoch milliseconds throughout.
 */

export type Project = typeof schema.projects.$inferSelect;
export type Repository = typeof schema.repositories.$inferSelect;
export type Task = typeof schema.tasks.$inferSelect;
export type DomainEvent = typeof schema.events.$inferSelect;
export type Update = typeof schema.updates.$inferSelect;
export type Output = typeof schema.outputs.$inferSelect;
export type SandboxRun = typeof schema.sandboxRuns.$inferSelect;
export type Connection = typeof schema.connections.$inferSelect;

export type TaskStatus = Task['status'];
export type EventSource = DomainEvent['source'];
export type OutputKind = Output['kind'];

/**
 * Internal ranking signal (requirements 11). Drives display order and
 * notification policy — deliberately NOT surfaced as a label in the UI.
 */
export type Awareness = Update['awareness'];

// ------------------------------------------------------------------ inputs
// `id` and timestamps are assigned by the store, never by callers.

export type NewProject = Pick<Project, 'name' | 'slug'> & Partial<Pick<Project, 'description'>>;

export type NewRepository = Omit<Repository, 'id' | 'createdAt' | 'isPrimary' | 'provider'> &
  Partial<Pick<Repository, 'isPrimary' | 'provider'>>;

export type NewTask = Pick<Task, 'projectId' | 'title'> &
  Partial<Omit<Task, 'id' | 'projectId' | 'title' | 'createdAt' | 'updatedAt'>>;

export type NewEvent = Pick<DomainEvent, 'projectId' | 'source' | 'kind'> &
  Partial<Pick<DomainEvent, 'taskId' | 'externalId' | 'payload' | 'occurredAt'>>;

export type NewUpdate = Pick<Update, 'projectId' | 'summary'> &
  Partial<Pick<Update, 'taskId' | 'body' | 'awareness' | 'sourceUrl'>>;

export type NewOutput = Pick<Output, 'projectId' | 'kind' | 'title' | 'producedBy'> &
  Partial<Pick<Output, 'taskId' | 'status' | 'url' | 'storageKey' | 'metadata'>>;

export type NewSandboxRun = Pick<SandboxRun, 'taskId' | 'provider'> &
  Partial<Pick<SandboxRun, 'externalId' | 'status' | 'executor'>>;

export type TaskPatch = Partial<Omit<Task, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>;
export type SandboxRunPatch = Partial<Omit<SandboxRun, 'id' | 'taskId' | 'createdAt'>>;

// ------------------------------------------------------------------- store

export interface ProjectStore {
  create(input: NewProject): Promise<Project>;
  get(id: string): Promise<Project | null>;
  getBySlug(slug: string): Promise<Project | null>;
  list(options?: { limit?: number; includeArchived?: boolean }): Promise<Project[]>;
}

export interface RepositoryStore {
  create(input: NewRepository): Promise<Repository>;
  listByProject(projectId: string): Promise<Repository[]>;
  getPrimary(projectId: string): Promise<Repository | null>;
}

export interface TaskStore {
  create(input: NewTask): Promise<Task>;
  get(id: string): Promise<Task | null>;
  /** Partial update; `updatedAt` is maintained by the store. */
  patch(id: string, changes: TaskPatch): Promise<Task | null>;
  listByProject(
    projectId: string,
    options?: { statuses?: TaskStatus[]; limit?: number }
  ): Promise<Task[]>;
  /** Cross-project, for the Home view. */
  listRecent(limit?: number): Promise<Task[]>;
  /** Used to attach an incoming webhook to the task that produced the branch. */
  findByBranch(branch: string): Promise<Task | null>;
}

export interface EventStore {
  /**
   * Append a raw fact.
   *
   * Idempotent on (source, externalId): a redelivered webhook returns the
   * already-stored event rather than creating a duplicate.
   */
  append(input: NewEvent): Promise<DomainEvent>;
  listByTask(taskId: string, limit?: number): Promise<DomainEvent[]>;
}

export interface UpdateStore {
  create(input: NewUpdate, fromEventIds?: string[]): Promise<Update>;
  listByProject(
    projectId: string,
    options?: { limit?: number; awareness?: Awareness[] }
  ): Promise<Update[]>;
  markRead(id: string): Promise<void>;
}

export interface OutputStore {
  create(input: NewOutput): Promise<Output>;
  listByProject(projectId: string, limit?: number): Promise<Output[]>;
  listByTask(taskId: string): Promise<Output[]>;
}

export interface SandboxRunStore {
  create(input: NewSandboxRun): Promise<SandboxRun>;
  patch(id: string, changes: SandboxRunPatch): Promise<void>;
  listByTask(taskId: string): Promise<SandboxRun[]>;
}

export interface SpindleStore {
  projects: ProjectStore;
  repositories: RepositoryStore;
  tasks: TaskStore;
  events: EventStore;
  updates: UpdateStore;
  outputs: OutputStore;
  sandboxRuns: SandboxRunStore;
}
