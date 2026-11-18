-- レビューの行は作った社員のタスクごとに 1 行にする。差し戻しの後の出し直しは同じ行を直す (タスクとレビューの 3.1)
-- 前の出し直しが足した重なりは、新しい方 (ID の大きい方) だけを残す。消す行を指す指摘と GitHub への写しは、先に残す行へ付け替える
-- 指摘は追記だけなので、付け替える間だけ書き換えの守りを外し、同じ文で付け直す
DROP TRIGGER `review_notes_no_update`;
--> statement-breakpoint
UPDATE `review_notes` SET `review_id` = (SELECT MAX(`k`.`id`) FROM `reviews` `r` JOIN `reviews` `k` ON `k`.`node_id` = `r`.`node_id` WHERE `r`.`id` = `review_notes`.`review_id`) WHERE `review_id` IN (SELECT `id` FROM `reviews` WHERE `id` NOT IN (SELECT MAX(`id`) FROM `reviews` GROUP BY `node_id`));
--> statement-breakpoint
CREATE TRIGGER review_notes_no_update BEFORE UPDATE ON review_notes BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
UPDATE `github_mirrors` SET `review_id` = (SELECT MAX(`k`.`id`) FROM `reviews` `r` JOIN `reviews` `k` ON `k`.`node_id` = `r`.`node_id` WHERE `r`.`id` = `github_mirrors`.`review_id`) WHERE `review_id` IN (SELECT `id` FROM `reviews` WHERE `id` NOT IN (SELECT MAX(`id`) FROM `reviews` GROUP BY `node_id`));
--> statement-breakpoint
DELETE FROM `reviews` WHERE `id` NOT IN (SELECT MAX(`id`) FROM `reviews` GROUP BY `node_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_node` ON `reviews` (`node_id`);
