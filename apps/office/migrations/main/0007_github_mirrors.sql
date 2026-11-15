CREATE TABLE `github_mirrors` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_until` integer,
	`github_id` integer,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `github_mirrors_pending` ON `github_mirrors` (`sent_at`,`id`);