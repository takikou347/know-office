-- 設計書から作った Issue。1 行が親か子の Issue 1 件で、GitHub に送る前に pending の行を取る (開発の回し方の 3.3、データの 2 章)
CREATE TABLE `dev_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`repo` text NOT NULL,
	`number` integer,
	`issue_id` integer,
	`parent_number` integer,
	`kind` text NOT NULL,
	`feature` text NOT NULL,
	`requirement` text,
	`req_hash` text,
	`issue_kind` text,
	`paths` text,
	`mark_key` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_issues_parent` ON `dev_issues` (`service_id`,`feature`) WHERE "dev_issues"."kind" = 'parent';--> statement-breakpoint
CREATE UNIQUE INDEX `dev_issues_child` ON `dev_issues` (`service_id`,`feature`,`requirement`,`req_hash`) WHERE "dev_issues"."kind" = 'child';--> statement-breakpoint
CREATE UNIQUE INDEX `dev_issues_number` ON `dev_issues` (`repo`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `dev_issues_mark` ON `dev_issues` (`mark_key`);