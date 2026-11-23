-- 目標とタスクの期限の日 (日本時間の YYYY-MM-DD)。無ければ NULL (タスクとレビューの 3.1、データの 2 章)
ALTER TABLE `nodes` ADD `due_day` text;
