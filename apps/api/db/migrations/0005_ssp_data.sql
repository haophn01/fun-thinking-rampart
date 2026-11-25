CREATE TABLE `asset` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`asset_type` text,
	`owner` text,
	`location` text,
	`treatment` text,
	`out_of_scope_justification` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "asset_category_check" CHECK("asset"."category" in ('cui', 'spa', 'crma', 'specialized', 'out_of_scope')),
	CONSTRAINT "asset_out_of_scope_justification_check" CHECK("asset"."category" <> 'out_of_scope' or "asset"."out_of_scope_justification" is not null)
);
--> statement-breakpoint
CREATE TABLE `diagram_link` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`version` integer,
	`kind` text NOT NULL,
	`caption` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence_item`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "diagram_link_version_check" CHECK("diagram_link"."version" >= 1),
	CONSTRAINT "diagram_link_kind_check" CHECK("diagram_link"."kind" in ('network', 'data_flow', 'other'))
);
--> statement-breakpoint
CREATE TABLE `responsibility` (
	`assessment_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`party` text,
	`provider_id` text,
	`note` text,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`assessment_id`, `requirement_id`),
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_id`) REFERENCES `service_provider`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "responsibility_party_check" CHECK("responsibility"."party" in ('organization', 'esp', 'shared')),
	CONSTRAINT "responsibility_provider_check" CHECK(("responsibility"."party" is not null and "responsibility"."party" in ('esp', 'shared')
        and "responsibility"."provider_id" is not null)
        or (("responsibility"."party" is null or "responsibility"."party" = 'organization')
        and "responsibility"."provider_id" is null))
);
--> statement-breakpoint
CREATE INDEX `responsibility_provider_id_idx` ON `responsibility` (`provider_id`);--> statement-breakpoint
CREATE TABLE `service_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`name` text NOT NULL,
	`provider_type` text NOT NULL,
	`fedramp_status` text,
	`services` text,
	`agreement_reference` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "service_provider_type_check" CHECK("service_provider"."provider_type" in ('cloud', 'msp', 'mssp', 'other'))
);
--> statement-breakpoint
CREATE TABLE `ssp_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`approved_on` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ssp_profile` (
	`assessment_id` text PRIMARY KEY NOT NULL,
	`categorization` text,
	`security_officer` text,
	`security_officer_email` text,
	`organization_address` text,
	`organization_phone` text,
	`cui_categories` text,
	`cui_locations` text,
	`cui_entry_exit` text,
	`topology_narrative` text,
	`data_flow_narrative` text,
	`inventory_reference` text,
	`maintenance_statement` text,
	`review_cadence_months` integer NOT NULL,
	`next_review_date` text,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ssp_profile_review_cadence_check" CHECK("ssp_profile"."review_cadence_months" between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE `ssp_revision` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`kind` text NOT NULL,
	`revised_on` text NOT NULL,
	`description` text NOT NULL,
	`made_by` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ssp_revision_kind_check" CHECK("ssp_revision"."kind" in ('export', 'manual'))
);
--> statement-breakpoint
CREATE TABLE `system_role` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`title` text NOT NULL,
	`person` text,
	`responsibilities` text,
	`user_count` integer NOT NULL,
	`privileged` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "system_role_user_count_check" CHECK("system_role"."user_count" >= 0),
	CONSTRAINT "system_role_privileged_check" CHECK("system_role"."privileged" in (0, 1))
);
--> statement-breakpoint
ALTER TABLE `requirement_state` ADD `planned_implementation` text;--> statement-breakpoint
ALTER TABLE `requirement_state` ADD `na_rationale` text;