CREATE TABLE `github_states` (
	`nonce` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
DROP TABLE `github_deliveries`;
--> statement-breakpoint
CREATE TABLE `github_deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`body_sha256` text NOT NULL,
	`event` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_deliveries_body_sha256_unique` ON `github_deliveries` (`body_sha256`);
