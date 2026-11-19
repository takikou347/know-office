-- アプリが返した 5xx の数を、Worker のエラー (errors) と別に持つ。5xx を数える前の行は null のまま残す。列を足すだけなので、追記専用の守りのトリガー (書き換えと消すを断る) は外さない。データの 3.2
ALTER TABLE `service_metrics` ADD `server_errors` integer;
