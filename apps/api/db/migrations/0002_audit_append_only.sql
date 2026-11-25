-- Custom SQL migration (drizzle-kit generate --custom): audit_event is append-only.
-- Any UPDATE or DELETE aborts the statement, and with it the caller's transaction.
CREATE TRIGGER `audit_event_no_update` BEFORE UPDATE ON `audit_event`
BEGIN
	SELECT RAISE(ABORT, 'audit_event is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_event_no_delete` BEFORE DELETE ON `audit_event`
BEGIN
	SELECT RAISE(ABORT, 'audit_event is append-only');
END;
