CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`week` text NOT NULL,
	`batch_id` text,
	`status` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batches_kind_week` ON `batches` (`kind`,`week`);--> statement-breakpoint
ALTER TABLE `lessons` ADD `staff_id` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `claimed_at` integer;