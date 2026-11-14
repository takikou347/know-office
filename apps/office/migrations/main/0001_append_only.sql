-- 追記専用のテーブルの書き換えと消すを断る。データの 3.2
CREATE TRIGGER login_attempts_no_update BEFORE UPDATE ON login_attempts BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER login_attempts_no_delete BEFORE DELETE ON login_attempts BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER health_checks_no_update BEFORE UPDATE ON health_checks BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER health_checks_no_delete BEFORE DELETE ON health_checks BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER staff_prompts_no_update BEFORE UPDATE ON staff_prompts BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER staff_prompts_no_delete BEFORE DELETE ON staff_prompts BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER attendance_no_update BEFORE UPDATE ON attendance BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER attendance_no_delete BEFORE DELETE ON attendance BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER work_entries_no_update BEFORE UPDATE ON work_entries BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER work_entries_no_delete BEFORE DELETE ON work_entries BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER day_orders_no_update BEFORE UPDATE ON day_orders BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER day_orders_no_delete BEFORE DELETE ON day_orders BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER staff_buckets_no_update BEFORE UPDATE ON staff_buckets BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER staff_buckets_no_delete BEFORE DELETE ON staff_buckets BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER stops_no_update BEFORE UPDATE ON stops BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER stops_no_delete BEFORE DELETE ON stops BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER stop_updates_no_update BEFORE UPDATE ON stop_updates BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER stop_updates_no_delete BEFORE DELETE ON stop_updates BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER transcript_parts_no_update BEFORE UPDATE ON transcript_parts BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER transcript_parts_no_delete BEFORE DELETE ON transcript_parts BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER review_notes_no_update BEFORE UPDATE ON review_notes BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER review_notes_no_delete BEFORE DELETE ON review_notes BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER service_events_no_update BEFORE UPDATE ON service_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER service_events_no_delete BEFORE DELETE ON service_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER settings_no_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER settings_no_delete BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER service_settings_no_update BEFORE UPDATE ON service_settings BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER service_settings_no_delete BEFORE DELETE ON service_settings BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER owner_data_reads_no_update BEFORE UPDATE ON owner_data_reads BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER owner_data_reads_no_delete BEFORE DELETE ON owner_data_reads BEGIN SELECT RAISE(ABORT, 'append only'); END;
