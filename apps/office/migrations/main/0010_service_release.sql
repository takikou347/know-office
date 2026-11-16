-- 公開は、サービスごとに読んだパッケージの版の組 (detail の key) で 1 行だけにする。同時に届いた 2 つの push の片方は書かない (サービスと拡張の 3.2)
CREATE UNIQUE INDEX `service_events_release` ON `service_events` (`service_id`, json_extract(`detail`, '$.key')) WHERE `kind` = 'release';
