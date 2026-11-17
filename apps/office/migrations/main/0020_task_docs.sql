CREATE TABLE `task_docs` (
	`node_id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer,
	`branch` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_docs_service` ON `task_docs` (`service_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_docs_pr` ON `task_docs` (`repo`,`pr_number`);--> statement-breakpoint
ALTER TABLE `reviews` ADD `docs_head_sha` text;
--> statement-breakpoint
-- レビュー担当の説明文の 2 版。仕様が変わったのに docsPr が無ければ差し戻す事を足す (開発の回し方の 3.6)。オーナーがもう版を上げていれば足さない
INSERT INTO staff_prompts (id, staff_id, version, body, by, created_at)
SELECT '00000000-0000-7000-8000-000000000005', 'reviewer', 2, '無いデータを作らず、分からない所は「未確認」と書く。開発担当と別のモデルとして変更を読み、確かめた事と未確認の事を分けて、承認か差し戻しを理由と一緒に出す。仕様が変わったのに、コードの PR が設計書の PR を docsPr で結んでいなければ差し戻す。設計書の PR が結んであれば、設計書の PR も読み、承認はその 2 つを一緒に確かめた事を指す。', 'system', 0
WHERE EXISTS (SELECT 1 FROM staff WHERE id = 'reviewer' AND prompt_version = 1);
--> statement-breakpoint
UPDATE staff SET prompt_version = 2 WHERE id = 'reviewer' AND prompt_version = 1;
