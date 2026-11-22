-- 手元で画面を眺めるためのデモデータ (pnpm local:demo)。e2e/seed.sql の勤怠、目的と組織図の木、レビュー待ちのタスクに重ねて流す。
-- 何度流しても同じ ID の行を重ねない。本物の宛先の名前は使わず、リポジトリは代わりの GitHub (dev/github.ts) にある example/ の物にする
-- オーナーの承認を待つ外部連携。ダッシュボードの「承認を待つ物」と承認の画面に出る
INSERT OR IGNORE INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES
  ('019a7b00-0000-7000-8000-0000000000f1', 'task', '019a7b00-0000-7000-8000-0000000000d3', 'office', 'Slack に通知を送る', NULL, 'build', 'builder', 'waiting_owner', 13, 'president', 1795300000000, 1795300000000),
  ('019a7b00-0000-7000-8000-0000000000f2', 'task', '019a7b00-0000-7000-8000-0000000000d3', 'office', '勤怠の CSV を書き出す', NULL, 'build', 'builder', 'todo', 14, 'president', 1795300000000, 1795300000000);
INSERT OR IGNORE INTO approvals (id, kind, target, payload, status, requested_by, requested_at) VALUES
  ('019a7b00-0000-7000-8000-0000000000f3', 'external_integration', 'Slack', '{"nodeId":"019a7b00-0000-7000-8000-0000000000f1"}', 'pending', 'builder', 1795300000000);
-- 運用中の見本の Web アプリ。アイデアとサービスの画面に出る
INSERT OR IGNORE INTO services (id, name, kind, stage, idea_id, repo, staff_id, aim, users, cost_estimate, revenue_estimate, study_key, dropped_reason, created_at) VALUES
  ('019a7b00-0000-7000-8000-0000000000f4', 'sample-app', 'web_app', 'operation', NULL, 'example/know-office', 'builder', '見本の Web アプリ', NULL, NULL, NULL, NULL, NULL, 1795300000000);
-- 読んでいない通知。画面の上の帯に出る
INSERT OR IGNORE INTO notices (id, at, level, kind, title, body, scope) VALUES
  ('019a7b00-0000-7000-8000-0000000000f5', 1795300000000, 'warn', 'demo', 'デモの通知: 開発担当が承認を待っています', 'Slack への通知の外部連携に、オーナーの承認が要ります', 'office');
