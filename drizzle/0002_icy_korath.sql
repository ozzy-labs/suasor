CREATE TABLE `slack_teams` (
	`team_id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`observed_at` text NOT NULL
);
