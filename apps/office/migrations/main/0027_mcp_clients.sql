CREATE TABLE `mcp_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_clients_token_hash_unique` ON `mcp_clients` (`token_hash`);