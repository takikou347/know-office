CREATE TABLE `locks` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`until` integer NOT NULL
);
