-- 画面の通しで勤怠の表に出す、作る役の 2026-11-13 (日本時間) の記録。勤怠は追記専用なので、何度流しても同じ ID の行を重ねない
-- 9 時から 17 時 10 分まで働き、12 時から 15 分止められ、17 時からチェックポイントを 10 分待った
INSERT OR IGNORE INTO attendance (id, staff_id, day, kind, started_at, ended_at, reason, corrects, note, created_at) VALUES
  ('019a7b00-0000-7000-8000-0000000000a1', 'builder', '2026-11-13', 'scheduled', 1794528000000, 1794538800000, 'schedule', NULL, NULL, 1794538800000),
  ('019a7b00-0000-7000-8000-0000000000a2', 'builder', '2026-11-13', 'stopped', 1794538800000, 1794539700000, 'guard_stop', NULL, NULL, 1794539700000),
  ('019a7b00-0000-7000-8000-0000000000a3', 'builder', '2026-11-13', 'scheduled', 1794539700000, 1794556800000, 'schedule', NULL, NULL, 1794556800000),
  ('019a7b00-0000-7000-8000-0000000000a4', 'builder', '2026-11-13', 'extension', 1794556800000, 1794557400000, 'checkpoint_wait', NULL, NULL, 1794557400000);
INSERT OR IGNORE INTO work_entries (id, staff_id, day, node_id, scope, title, started_at, ended_at, active_ms, result, corrects) VALUES
  ('019a7b00-0000-7000-8000-0000000000b1', 'builder', '2026-11-13', '019a7b00-0000-7000-8000-0000000000c1', 'knowidea-ui', 'DiffView の行番号を直す', 1794528000000, 1794534000000, 6000000, 'done', NULL),
  ('019a7b00-0000-7000-8000-0000000000b2', 'builder', '2026-11-13', '019a7b00-0000-7000-8000-0000000000c2', 'knowidea-ui', 'CodeEditor のページを足す', 1794534300000, 1794543600000, 8400000, 'handed_back', NULL),
  ('019a7b00-0000-7000-8000-0000000000b3', 'builder', '2026-11-13', '019a7b00-0000-7000-8000-0000000000c3', 'office', '勤怠の表の画面を作る', 1794544200000, 1794557400000, 13200000, 'continued', NULL);
INSERT OR REPLACE INTO daily_totals (staff_id, day, clock_in, clock_out, worked_ms, extension_ms, call_ms, stopped_ms, waiting_ms, reasons) VALUES
  ('builder', '2026-11-13', 1794528000000, 1794557400000, 28500000, 600000, 0, 900000, 0, '["extension:checkpoint_wait","stopped:guard_stop"]');
