-- オーナーの発言を社員に渡した印。発言 1 件に 1 行で、追記専用 (社員が考えるの 3.9、データの 2 章)
CREATE TABLE `message_deliveries` (
	`message_id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`node_id` text,
	`via` text NOT NULL,
	`delivered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER message_deliveries_no_update BEFORE UPDATE ON message_deliveries BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER message_deliveries_no_delete BEFORE DELETE ON message_deliveries BEGIN SELECT RAISE(ABORT, 'append only'); END;
