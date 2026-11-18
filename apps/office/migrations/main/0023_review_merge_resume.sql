ALTER TABLE `reviews` ADD `merged_at` integer;--> statement-breakpoint
ALTER TABLE `reviews` ADD `merge_started_at` integer;--> statement-breakpoint
ALTER TABLE `reviews` ADD `merge_started_sha` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `merge_tries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` ADD `merge_retry_at` integer;--> statement-breakpoint
CREATE INDEX `reviews_merge_pending` ON `reviews` (`merge_started_at`) WHERE "reviews"."merged_at" IS NULL AND "reviews"."merge_started_at" IS NOT NULL;