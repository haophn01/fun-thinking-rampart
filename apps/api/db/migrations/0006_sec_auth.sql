CREATE TABLE `mfa_recovery_code` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mfa_recovery_code_user_id_idx` ON `mfa_recovery_code` (`user_id`);--> statement-breakpoint
CREATE TABLE `password_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `password_history_user_id_idx` ON `password_history` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`sign_in_notice` text,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "settings_single_row_check" CHECK("settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE `audit_event` ADD `prev_hash` text;--> statement-breakpoint
ALTER TABLE `audit_event` ADD `hash` text;--> statement-breakpoint
ALTER TABLE `session` ADD `locked_at` text;--> statement-breakpoint
ALTER TABLE `session` ADD `mfa_pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `password_changed_at` text;--> statement-breakpoint
ALTER TABLE `user` ADD `mfa_secret_enc` text;--> statement-breakpoint
ALTER TABLE `user` ADD `mfa_last_step` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `mfa_enrolled_at` text;--> statement-breakpoint
-- Hand-written (snapshots don't track triggers): the audit log stays append-only, except that a
-- row's empty prev_hash and hash may be filled once, with every other column unchanged, so
-- sec-integrity can backfill the hash chain in code with no second migration.
DROP TRIGGER `audit_event_no_update`;--> statement-breakpoint
CREATE TRIGGER `audit_event_no_update` BEFORE UPDATE ON `audit_event`
WHEN NOT (
	OLD.`hash` IS NULL AND OLD.`prev_hash` IS NULL AND NEW.`hash` IS NOT NULL
	AND NEW.`id` IS OLD.`id`
	AND NEW.`at` IS OLD.`at`
	AND NEW.`actor_user_id` IS OLD.`actor_user_id`
	AND NEW.`assessment_id` IS OLD.`assessment_id`
	AND NEW.`action` IS OLD.`action`
	AND NEW.`entity_type` IS OLD.`entity_type`
	AND NEW.`entity_id` IS OLD.`entity_id`
	AND NEW.`before` IS OLD.`before`
	AND NEW.`after` IS OLD.`after`
	AND NEW.`request_id` IS OLD.`request_id`
)
BEGIN
	SELECT RAISE(ABORT, 'audit_event is append-only');
END;
