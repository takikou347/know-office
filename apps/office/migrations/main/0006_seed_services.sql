-- 最初のサービスの knowidea-ui と、2 番目の know-office 自身を登録する (サービスと拡張の 3.1 と 3.3、タスクとレビューの 3.4 の表)。何度流しても同じ ID の行を重ねない
INSERT INTO services (id, name, kind, stage, idea_id, repo, staff_id, aim, users, cost_estimate, revenue_estimate, study_key, dropped_reason, created_at) VALUES
  ('00000000-0000-7000-8000-000000000101', 'knowidea-ui', 'library', 'operation', NULL, 'takikou347/knowidea-ui', 'builder', 'KNOW IDEA のアプリが共通で使う画面のコンポーネントの集まり', 'KNOW IDEA のアプリ', NULL, NULL, NULL, NULL, 0),
  ('00000000-0000-7000-8000-000000000102', 'know-office', 'web_app', 'prototype', NULL, 'takikou347/know-office', 'builder', 'オーナーが AI の社員とその成果を管理する管理室のアプリ', 'オーナー', NULL, NULL, NULL, NULL, 1)
  ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO service_events (id, at, service_id, kind, by, detail) VALUES
  ('00000000-0000-7000-8000-000000000104', 0, '00000000-0000-7000-8000-000000000101', 'stage', 'system', '{"to":"operation"}'),
  ('00000000-0000-7000-8000-000000000105', 1, '00000000-0000-7000-8000-000000000102', 'stage', 'system', '{"to":"prototype"}')
  ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
-- knowidea-ui は登録した時から、本番にデプロイする条件にチェックとレビュー担当の承認を持つ。ほかの項目と know-office は office の初期値を受け継ぐ
INSERT INTO service_settings (id, service_id, key, value, version, by, created_at) VALUES
  ('00000000-0000-7000-8000-000000000103', '00000000-0000-7000-8000-000000000101', 'deployWhen', '["checks","reviewer"]', 1, 'system', 0)
  ON CONFLICT (id) DO NOTHING;
