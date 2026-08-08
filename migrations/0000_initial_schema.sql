CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`config` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_connections_identity` ON `connections` (`kind`,`external_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`occurred_at` integer NOT NULL,
	`ingested_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_events_external` ON `events` (`source`,`external_id`) WHERE external_id is not null;--> statement-breakpoint
CREATE INDEX `idx_events_task` ON `events` (`task_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_events_project` ON `events` (`project_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`status` text,
	`url` text,
	`storage_key` text,
	`metadata` text,
	`produced_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_outputs_project` ON `outputs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_outputs_task` ON `outputs` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`installation_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repositories_identity` ON `repositories` (`project_id`,`provider`,`owner`,`name`);--> statement-breakpoint
CREATE INDEX `idx_repositories_project` ON `repositories` (`project_id`);--> statement-breakpoint
CREATE TABLE `sandbox_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text,
	`status` text DEFAULT 'creating' NOT NULL,
	`executor` text,
	`head_commit` text,
	`snapshot_ref` text,
	`log_key` text,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sandbox_runs_task` ON `sandbox_runs` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`repository_id` text,
	`title` text NOT NULL,
	`intent` text,
	`status` text DEFAULT 'to_do' NOT NULL,
	`status_reason` text,
	`branch` text,
	`base_branch` text,
	`origin_kind` text,
	`origin_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_project_status` ON `tasks` (`project_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_updated` ON `tasks` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_branch` ON `tasks` (`branch`);--> statement-breakpoint
CREATE TABLE `update_events` (
	`update_id` text NOT NULL,
	`event_id` text NOT NULL,
	FOREIGN KEY (`update_id`) REFERENCES `updates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `updates` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`summary` text NOT NULL,
	`body` text,
	`awareness` text DEFAULT 'awareness_required' NOT NULL,
	`source_url` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_updates_project` ON `updates` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_updates_awareness` ON `updates` (`project_id`,`awareness`,`created_at`);