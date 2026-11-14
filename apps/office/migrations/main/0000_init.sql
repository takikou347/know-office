CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`payload` text,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_at` integer,
	`reason` text
);
--> statement-breakpoint
CREATE TABLE `attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`reason` text,
	`corrects` text,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attendance_staff_day` ON `attendance` (`staff_id`,`day`);--> statement-breakpoint
CREATE TABLE `daily_totals` (
	`staff_id` text NOT NULL,
	`day` text NOT NULL,
	`clock_in` integer,
	`clock_out` integer,
	`worked_ms` integer NOT NULL,
	`extension_ms` integer NOT NULL,
	`call_ms` integer NOT NULL,
	`stopped_ms` integer NOT NULL,
	`waiting_ms` integer NOT NULL,
	`reasons` text,
	PRIMARY KEY(`staff_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `day_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`until` integer,
	`source` text NOT NULL,
	`cancels` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`repo` text,
	`issue_number` integer,
	`kind` text NOT NULL,
	`count` integer NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`status` text NOT NULL,
	`fixed_at` integer,
	`effect` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_fingerprint_unique` ON `findings` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `github_deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `health_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`part` text NOT NULL,
	`ok` integer NOT NULL,
	`ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text NOT NULL,
	`cause` text NOT NULL,
	`proposal` text NOT NULL,
	`stop_ids` text,
	`status` text NOT NULL,
	`applied_at` integer
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`ip` text NOT NULL,
	`country` text,
	`kind` text NOT NULL,
	`ok` integer NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `login_attempts_ip_at` ON `login_attempts` (`ip`,`at`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`scope` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`task_kind` text,
	`assignee` text,
	`status` text NOT NULL,
	`priority` integer NOT NULL,
	`repo` text,
	`branch` text,
	`pr_number` integer,
	`issue_number` integer,
	`source` text,
	`progress` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nodes_parent` ON `nodes` (`parent_id`);--> statement-breakpoint
CREATE INDEX `nodes_assignee_status` ON `nodes` (`assignee`,`status`);--> statement-breakpoint
CREATE TABLE `notices` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`scope` text NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE TABLE `owner_data` (
	`id` text PRIMARY KEY NOT NULL,
	`ext_id` text NOT NULL,
	`field` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owner_data_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`by` text NOT NULL,
	`ext_id` text NOT NULL,
	`field` text NOT NULL,
	`node_id` text
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `record_years` (
	`year` integer PRIMARY KEY NOT NULL,
	`binding` text NOT NULL,
	`state` text NOT NULL,
	`first_hash` text,
	`last_hash` text
);
--> statement-breakpoint
CREATE TABLE `review_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`at` integer NOT NULL,
	`by` text NOT NULL,
	`path` text NOT NULL,
	`line` integer NOT NULL,
	`side` text NOT NULL,
	`body` text NOT NULL,
	`github_comment_id` integer
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`last_seen_sha` text,
	`checks` text,
	`reviewer_summary` text,
	`reviewer_verdict` text,
	`owner_verdict` text
);
--> statement-breakpoint
CREATE TABLE `service_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`service_id` text NOT NULL,
	`kind` text NOT NULL,
	`by` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `service_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`version` integer NOT NULL,
	`by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`stage` text NOT NULL,
	`idea_id` text,
	`repo` text,
	`staff_id` text,
	`aim` text,
	`users` text,
	`cost_estimate` integer,
	`revenue_estimate` integer,
	`study_key` text,
	`dropped_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	`step_up_until` integer,
	`ip` text NOT NULL,
	`country` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `sessions_token_hash` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`scope` text NOT NULL,
	`value` text,
	`version` integer NOT NULL,
	`changed_by` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `settings_key_scope` ON `settings` (`key`,`scope`,`version`);--> statement-breakpoint
CREATE TABLE `staff` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`boss_id` text,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `staff_buckets` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`bucket_at` integer NOT NULL,
	`tokens` integer NOT NULL,
	`tool_calls` integer NOT NULL,
	`on_duty` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `staff_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stop_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`stop_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`by` text NOT NULL,
	`verdict` text,
	`reason` text,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `stops` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`target` text NOT NULL,
	`signal` text NOT NULL,
	`measured` integer NOT NULL,
	`threshold` integer NOT NULL,
	`rules_version` integer NOT NULL,
	`recent_ops_key` text,
	`node_progress` text,
	`external_sources` text,
	`model` text,
	`by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcript_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`node_id` text NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`key` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vault` (
	`name` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	PRIMARY KEY(`name`, `version`)
);
--> statement-breakpoint
CREATE TABLE `work_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`day` text NOT NULL,
	`node_id` text NOT NULL,
	`scope` text NOT NULL,
	`title` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`active_ms` integer NOT NULL,
	`result` text NOT NULL,
	`corrects` text
);
--> statement-breakpoint
CREATE INDEX `work_entries_staff_day` ON `work_entries` (`staff_id`,`day`);