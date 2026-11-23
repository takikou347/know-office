-- 月の予算に収めるため、社長を Sonnet 5.5 と考える深さ medium にする (社員が考えるの 3.10)
UPDATE staff SET model = 'claude-sonnet-5-5', effort = 'medium' WHERE id = 'president' AND model = 'claude-opus-5-5';
