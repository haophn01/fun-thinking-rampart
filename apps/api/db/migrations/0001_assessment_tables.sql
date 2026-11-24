CREATE TABLE `audit_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor_user_id` text,
	`assessment_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text,
	`after` text,
	`request_id` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_event_entity_idx` ON `audit_event` (`entity_type`,`entity_id`,`id`);--> statement-breakpoint
CREATE TABLE `objective_result` (
	`assessment_id` text NOT NULL,
	`objective_id` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`assessment_id`, `objective_id`),
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "objective_result_status_check" CHECK("objective_result"."status" in ('met', 'not_met', 'na', 'not_assessed'))
);
--> statement-breakpoint
CREATE TABLE `requirement_state` (
	`assessment_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`implementation_level` text,
	`implementation_statement` text,
	`owner_user_id` text,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`assessment_id`, `requirement_id`),
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirement_state_level_check" CHECK("requirement_state"."implementation_level" in ('none', 'partial'))
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`failed_sign_ins` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "user_role_check" CHECK("user"."role" in ('admin', 'contributor')),
	CONSTRAINT "user_active_check" CHECK("user"."active" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);