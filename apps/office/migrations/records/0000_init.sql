CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`scope` text NOT NULL,
	`detail` text,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	`trace_id` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_trace` ON `audit_log` (`trace_id`);--> statement-breakpoint
CREATE INDEX `audit_log_at` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `error_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`source` text NOT NULL,
	`level` text NOT NULL,
	`code` text NOT NULL,
	`message` text NOT NULL,
	`route` text,
	`status` integer,
	`staff_id` text,
	`node_id` text,
	`fingerprint` text NOT NULL,
	`detail` text,
	`trace_id` text
);
--> statement-breakpoint
CREATE INDEX `error_events_trace` ON `error_events` (`trace_id`);--> statement-breakpoint
CREATE INDEX `error_events_fingerprint_at` ON `error_events` (`fingerprint`,`at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`staff_id` text NOT NULL,
	`node_id` text,
	`sender` text NOT NULL,
	`body` text NOT NULL,
	`body_key` text,
	`trace_id` text
);
--> statement-breakpoint
CREATE INDEX `messages_trace` ON `messages` (`trace_id`);--> statement-breakpoint
CREATE INDEX `messages_staff_at` ON `messages` (`staff_id`,`at`);--> statement-breakpoint
CREATE TABLE `node_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`node_id` text NOT NULL,
	`staff_id` text,
	`kind` text NOT NULL,
	`detail` text,
	`trace_id` text
);
--> statement-breakpoint
CREATE INDEX `node_events_trace` ON `node_events` (`trace_id`);--> statement-breakpoint
CREATE INDEX `node_events_node` ON `node_events` (`node_id`);--> statement-breakpoint
CREATE TABLE `service_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`at` integer NOT NULL,
	`requests` integer NOT NULL,
	`errors` integer NOT NULL,
	`users` integer,
	`reads` integer,
	`trace_id` text
);
--> statement-breakpoint
CREATE INDEX `service_metrics_trace` ON `service_metrics` (`trace_id`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`staff_id` text NOT NULL,
	`node_id` text,
	`scope` text NOT NULL,
	`tool` text NOT NULL,
	`op_kind` text NOT NULL,
	`target` text,
	`allowed` integer NOT NULL,
	`reason` text,
	`ms` integer,
	`trace_id` text
);
--> statement-breakpoint
CREATE INDEX `tool_calls_trace` ON `tool_calls` (`trace_id`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`staff_id` text NOT NULL,
	`node_id` text,
	`scope` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`cost_micro_usd` integer NOT NULL,
	`request_id` text,
	`waited_ms` integer,
	`trace_id` text
);
--> statement-breakpoint
CREATE INDEX `usage_trace` ON `usage` (`trace_id`);--> statement-breakpoint
CREATE INDEX `usage_at` ON `usage` (`at`);