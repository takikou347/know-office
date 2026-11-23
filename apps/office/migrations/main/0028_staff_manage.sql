-- 社員を足し、消し、社員ごとに設定する (データの 2 章、社員と勤怠の 1 章)。最初の 3 人の職種は ID と同じ。タスクの担当は在籍の社員だけに書ける
ALTER TABLE `staff` ADD `job` text NOT NULL DEFAULT 'builder';--> statement-breakpoint
ALTER TABLE `staff` ADD `schedule` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `staff` ADD `retired_at` integer;--> statement-breakpoint
UPDATE `staff` SET `job` = `id` WHERE `id` IN ('president', 'builder', 'reviewer');
--> statement-breakpoint
CREATE TRIGGER nodes_assignee_active_insert BEFORE INSERT ON nodes WHEN NEW.assignee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM staff WHERE id = NEW.assignee AND retired_at IS NULL) BEGIN SELECT RAISE(ABORT, 'assignee not active'); END;
--> statement-breakpoint
CREATE TRIGGER nodes_assignee_active_update BEFORE UPDATE OF assignee ON nodes WHEN NEW.assignee IS NOT NULL AND NEW.assignee IS NOT OLD.assignee AND NOT EXISTS (SELECT 1 FROM staff WHERE id = NEW.assignee AND retired_at IS NULL) BEGIN SELECT RAISE(ABORT, 'assignee not active'); END;
