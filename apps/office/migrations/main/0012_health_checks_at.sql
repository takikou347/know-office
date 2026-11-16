-- 確かめの行は消さずに増え続けるので、月の稼働率がその月の行だけを読めるようにする (サービスと拡張の 3 章)
CREATE INDEX `health_checks_at` ON `health_checks` (`at`);