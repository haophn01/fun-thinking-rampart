CREATE TABLE `evidence_item` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`contains_cui` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evidence_item_contains_cui_check" CHECK("evidence_item"."contains_cui" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE `evidence_link` (
	`evidence_id` text NOT NULL,
	`objective_id` text NOT NULL,
	PRIMARY KEY(`evidence_id`, `objective_id`),
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence_item`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evidence_link_objective_id_idx` ON `evidence_link` (`objective_id`);--> statement-breakpoint
CREATE TABLE `evidence_version` (
	`evidence_id` text NOT NULL,
	`version` integer NOT NULL,
	`contains_cui` integer NOT NULL,
	`file_name` text,
	`size` integer,
	`sha256` text,
	`storage_key` text,
	`reference_location` text,
	`reference_note` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`evidence_id`, `version`),
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence_item`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evidence_version_version_check" CHECK("evidence_version"."version" >= 1),
	CONSTRAINT "evidence_version_kind_check" CHECK(("evidence_version"."contains_cui" = 0 and "evidence_version"."file_name" is not null and "evidence_version"."size" is not null
        and "evidence_version"."sha256" is not null and "evidence_version"."storage_key" is not null
        and length("evidence_version"."sha256") = 64 and "evidence_version"."sha256" not glob '*[^0-9a-f]*'
        and "evidence_version"."size" >= 1
        and "evidence_version"."reference_location" is null and "evidence_version"."reference_note" is null)
        or ("evidence_version"."contains_cui" = 1 and "evidence_version"."file_name" is null and "evidence_version"."size" is null
        and "evidence_version"."sha256" is null and "evidence_version"."storage_key" is null
        and "evidence_version"."reference_location" is not null))
);
--> statement-breakpoint
CREATE TABLE `poam_item` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`plan` text NOT NULL,
	`due` text NOT NULL,
	`milestones` text DEFAULT '[]' NOT NULL,
	`owner_user_id` text,
	`closed_on` text,
	`closeout_note` text,
	`confirmed_by` text,
	`c3pao_name` text,
	`closed_by` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "poam_item_status_check" CHECK("poam_item"."status" in ('open', 'closed')),
	CONSTRAINT "poam_item_confirmed_by_check" CHECK("poam_item"."confirmed_by" in ('organization', 'c3pao')),
	CONSTRAINT "poam_item_closeout_check" CHECK(("poam_item"."status" = 'open' and "poam_item"."closed_on" is null and "poam_item"."closeout_note" is null
        and "poam_item"."confirmed_by" is null and "poam_item"."c3pao_name" is null and "poam_item"."closed_by" is null)
        or ("poam_item"."status" = 'closed' and "poam_item"."closed_on" is not null
        and "poam_item"."confirmed_by" is not null and "poam_item"."closed_by" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poam_item_open_requirement_unique` ON `poam_item` (`assessment_id`,`requirement_id`) WHERE status = 'open';--> statement-breakpoint
CREATE TABLE `policy` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `policy_link` (
	`policy_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	PRIMARY KEY(`policy_id`, `requirement_id`),
	FOREIGN KEY (`policy_id`) REFERENCES `policy`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `policy_link_requirement_id_idx` ON `policy_link` (`requirement_id`);--> statement-breakpoint
CREATE TABLE `policy_version` (
	`policy_id` text NOT NULL,
	`version` integer NOT NULL,
	`file_name` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`policy_id`, `version`),
	FOREIGN KEY (`policy_id`) REFERENCES `policy`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "policy_version_version_check" CHECK("policy_version"."version" >= 1),
	CONSTRAINT "policy_version_file_check" CHECK(length("policy_version"."sha256") = 64 and "policy_version"."sha256" not glob '*[^0-9a-f]*'
        and "policy_version"."size" >= 1)
);
