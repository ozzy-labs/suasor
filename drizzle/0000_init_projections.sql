CREATE TABLE `commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`direction` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`due_date` text,
	`person` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`source_external_id` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_kind` text NOT NULL,
	`from_id` text NOT NULL,
	`to_kind` text NOT NULL,
	`to_id` text NOT NULL,
	`relation` text NOT NULL,
	`link_id` text
);
--> statement-breakpoint
CREATE TABLE `person_identities` (
	`identity_key` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`connector` text NOT NULL,
	`handle` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `persons` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`identity_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`external_id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`body` text NOT NULL,
	`fingerprint` text NOT NULL,
	`observed_at` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`connector` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`status` text NOT NULL,
	`observed` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`unchanged` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'proposed' NOT NULL,
	`due_date` text,
	`priority` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
