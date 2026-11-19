-- 写したオーナーの GitHub のレビュー。レビュー 1 つに 1 行で、タスクの出来事の鍵の時刻を決める。追記専用 (タスクとレビューの 3.2、データの 2 章)
CREATE TABLE `github_reviews` (
	`github_review_id` integer PRIMARY KEY NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER github_reviews_no_update BEFORE UPDATE ON github_reviews BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER github_reviews_no_delete BEFORE DELETE ON github_reviews BEGIN SELECT RAISE(ABORT, 'append only'); END;
