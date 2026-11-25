CREATE TABLE `assessment` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text DEFAULT 'self' NOT NULL,
	`conditional_status_date` text,
	`catalog_version` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "assessment_type_check" CHECK("assessment"."type" in ('self', 'c3pao'))
);
