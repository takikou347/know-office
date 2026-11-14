-- 最初の 3 人の社員と、役目の説明文の 1 版を置く (データの 2.2、タスクとレビューの 3.1 と 3.7)
INSERT INTO staff (id, role, boss_id, model, effort, prompt_version, created_at) VALUES
  ('president', '社長', NULL, 'claude-opus-5-5', 'high', 1, 0),
  ('builder', '開発担当', 'president', 'claude-sonnet-5-5', 'high', 1, 0),
  ('reviewer', 'レビュー担当', 'president', 'claude-opus-5-5', 'high', 1, 0);
--> statement-breakpoint
INSERT INTO staff_prompts (id, staff_id, version, body, by, created_at) VALUES
  ('00000000-0000-7000-8000-000000000001', 'president', 1, '無いデータを作らず、分からない所は「未確認」と書く。目標をプロジェクトとタスクに分け、開発担当とレビュー担当に割り振る。社員の追加、役の変更、費用が増える事、新しい外部連携はオーナーに上げる。', 'system', 0),
  ('00000000-0000-7000-8000-000000000002', 'builder', 1, '無いデータを作らず、分からない所は「未確認」と書く。タスクを 1 つずつ取り、ワークスペースで直して試し、プルリクエストを出す。困った時は社長に上げる。', 'system', 0),
  ('00000000-0000-7000-8000-000000000003', 'reviewer', 1, '無いデータを作らず、分からない所は「未確認」と書く。開発担当と別のモデルとして変更を読み、確かめた事と未確認の事を分けて、承認か差し戻しを理由と一緒に出す。', 'system', 0);
