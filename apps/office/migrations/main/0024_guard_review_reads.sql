-- 止めた記録をレビュー担当のモデルに聞いた印 (自動停止の 3.5、データの 2 章)
CREATE TABLE `guard_review_reads` (
	`stop_id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `guard_review_reads_day` ON `guard_review_reads` (`day`);--> statement-breakpoint
CREATE TRIGGER guard_review_reads_no_update BEFORE UPDATE ON guard_review_reads BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER guard_review_reads_no_delete BEFORE DELETE ON guard_review_reads BEGIN SELECT RAISE(ABORT, 'append only'); END;
