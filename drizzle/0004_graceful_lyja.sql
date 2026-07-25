CREATE TABLE `demand_seen` (
	`external_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`seen_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `commitments` ADD `person_id` text;