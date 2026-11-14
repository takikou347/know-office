-- 追記専用のテーブルの書き換えと消すを断る。データの 3.2
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER error_events_no_update BEFORE UPDATE ON error_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER error_events_no_delete BEFORE DELETE ON error_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER tool_calls_no_update BEFORE UPDATE ON tool_calls BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER tool_calls_no_delete BEFORE DELETE ON tool_calls BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER usage_no_update BEFORE UPDATE ON usage BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER usage_no_delete BEFORE DELETE ON usage BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER node_events_no_update BEFORE UPDATE ON node_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER node_events_no_delete BEFORE DELETE ON node_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER service_metrics_no_update BEFORE UPDATE ON service_metrics BEGIN SELECT RAISE(ABORT, 'append only'); END;
--> statement-breakpoint
CREATE TRIGGER service_metrics_no_delete BEFORE DELETE ON service_metrics BEGIN SELECT RAISE(ABORT, 'append only'); END;
