-- 会話の言葉から勤務の指示を抜き出した発言の印と、指示の元の発言 ID (社員と勤怠の 3.4、データの 2 章)
CREATE TABLE `chat_order_reads` (
	`message_id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_order_reads_day` ON `chat_order_reads` (`day`);--> statement-breakpoint
ALTER TABLE `day_orders` ADD `message_id` text;--> statement-breakpoint
CREATE INDEX `day_orders_message` ON `day_orders` (`message_id`);--> statement-breakpoint
CREATE TRIGGER chat_order_reads_no_update BEFORE UPDATE ON chat_order_reads BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER chat_order_reads_no_delete BEFORE DELETE ON chat_order_reads BEGIN SELECT RAISE(ABORT, 'append only'); END;
