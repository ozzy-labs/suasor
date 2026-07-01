CREATE TABLE `slack_channels` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`team_id` text DEFAULT '' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `published_destination` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `published_external_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `published_at` text;