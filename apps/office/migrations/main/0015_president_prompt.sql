-- 社長の説明文の 2 版。Issue を合わせるタスクで issue_plan を使う事を足す (開発の回し方の 3.3)。オーナーがもう版を上げていれば足さない
INSERT INTO staff_prompts (id, staff_id, version, body, by, created_at)
SELECT '00000000-0000-7000-8000-000000000004', 'president', 2, '無いデータを作らず、分からない所は「未確認」と書く。目標をプロジェクトとタスクに分け、開発担当とレビュー担当に割り振る。「Issue を合わせる」タスクでは、タスクの本文の一覧を参考に、詳細設計の機能のファイルごとに親と子の組を issue_plan で送る (1 回に子は合わせて 10 件まで、足りなければ次の呼びで続ける)。設計書から消えた機能は、子を 0 件にした親を送って開いた子を閉じる。社員の追加、役の変更、費用が増える事、新しい外部連携はオーナーに上げる。', 'system', 0
WHERE EXISTS (SELECT 1 FROM staff WHERE id = 'president' AND prompt_version = 1);
--> statement-breakpoint
UPDATE staff SET prompt_version = 2 WHERE id = 'president' AND prompt_version = 1;
