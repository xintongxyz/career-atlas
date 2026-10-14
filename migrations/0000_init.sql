CREATE TABLE `application_documents` (
	`application_id` text NOT NULL,
	`document_id` text NOT NULL,
	`role` text DEFAULT 'other' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`application_id`, `document_id`),
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`saved_job_id` text NOT NULL,
	`application_id` text,
	`type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`title` text,
	`details` text,
	`metadata` text,
	`occurred_at` integer NOT NULL,
	`scheduled_for` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`saved_job_id`) REFERENCES `saved_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `events_user_occurred_idx` ON `application_events` (`user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `events_saved_job_idx` ON `application_events` (`saved_job_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`saved_job_id` text NOT NULL,
	`job_posting_id` text NOT NULL,
	`status` text DEFAULT 'applied' NOT NULL,
	`applied_at` integer NOT NULL,
	`applied_via` text,
	`last_activity_at` integer NOT NULL,
	`first_response_at` integer,
	`last_response_at` integer,
	`next_follow_up_at` integer,
	`next_interview_at` integer,
	`offer_deadline_at` integer,
	`final_outcome_at` integer,
	`reached_assessment_at` integer,
	`reached_interview_at` integer,
	`reached_offer_at` integer,
	`resume_document_id` text,
	`cover_letter_document_id` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`saved_job_id`) REFERENCES `saved_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_posting_id`) REFERENCES `job_postings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resume_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cover_letter_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_saved_job_uq` ON `applications` (`saved_job_id`);--> statement-breakpoint
CREATE INDEX `applications_user_status_idx` ON `applications` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `applications_user_applied_idx` ON `applications` (`user_id`,`applied_at`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`website` text,
	`domain` text,
	`logo_url` text,
	`industry` text,
	`description` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `companies_user_name_idx` ON `companies` (`user_id`,`normalized_name`);--> statement-breakpoint
CREATE INDEX `companies_user_domain_idx` ON `companies` (`user_id`,`domain`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`company_id` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`title` text,
	`email` text,
	`phone` text,
	`linkedin_url` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `contacts_user_idx` ON `contacts` (`user_id`);--> statement-breakpoint
CREATE TABLE `custom_views` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`page` text DEFAULT 'positions' NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `custom_views_user_idx` ON `custom_views` (`user_id`,`page`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`version_name` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_user_kind_idx` ON `documents` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `extracted_field_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_posting_id` text NOT NULL,
	`extraction_job_id` text,
	`field` text NOT NULL,
	`value` text,
	`source` text NOT NULL,
	`evidence` text,
	`confidence` text NOT NULL,
	`review_status` text DEFAULT 'needs_review' NOT NULL,
	`extracted_at` integer NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_posting_id`) REFERENCES `job_postings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evidence_posting_field_idx` ON `extracted_field_evidence` (`job_posting_id`,`field`,`review_status`);--> statement-breakpoint
CREATE TABLE `job_extraction_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_posting_id` text NOT NULL,
	`purpose` text DEFAULT 'initial' NOT NULL,
	`input_type` text NOT NULL,
	`input_url` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`adapter` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`result` text,
	`snapshot_id` text,
	`started_at` integer,
	`finished_at` integer,
	`applied_at` integer,
	`dismissed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_posting_id`) REFERENCES `job_postings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `extraction_jobs_posting_idx` ON `job_extraction_jobs` (`job_posting_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `extraction_jobs_user_status_idx` ON `job_extraction_jobs` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `job_postings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`company_id` text NOT NULL,
	`external_job_id` text,
	`original_url` text,
	`canonical_url` text,
	`apply_url` text,
	`source_platform` text DEFAULT 'manual' NOT NULL,
	`title` text NOT NULL,
	`title_original` text,
	`category` text,
	`department` text,
	`seniority` text DEFAULT 'unknown' NOT NULL,
	`employment_type` text DEFAULT 'unknown' NOT NULL,
	`posted_at` integer,
	`deadline_at` integer,
	`posting_status` text DEFAULT 'unknown' NOT NULL,
	`content_language` text,
	`work_mode` text DEFAULT 'unspecified' NOT NULL,
	`city` text,
	`region` text,
	`country` text,
	`additional_locations` text,
	`remote_eligible_regions` text,
	`hybrid_frequency` text,
	`travel_requirement` text,
	`relocation_requirement` text,
	`salary_min` real,
	`salary_max` real,
	`salary_currency` text,
	`salary_period` text DEFAULT 'unknown' NOT NULL,
	`salary_source` text DEFAULT 'unknown' NOT NULL,
	`salary_text` text,
	`compensation_type` text,
	`bonus` text,
	`commission` text,
	`equity` text,
	`benefits` text,
	`compensation_notes` text,
	`description_text` text,
	`summary` text,
	`responsibilities` text,
	`required_qualifications` text,
	`preferred_qualifications` text,
	`technical_skills` text,
	`soft_skills` text,
	`tools` text,
	`education_requirements` text,
	`years_experience_min` integer,
	`years_experience_text` text,
	`language_requirements` text,
	`certifications` text,
	`other_requirements` text,
	`work_authorization` text,
	`visa_sponsorship` text DEFAULT 'unknown' NOT NULL,
	`visa_sponsorship_text` text,
	`citizenship_restriction` text,
	`residency_restriction` text,
	`security_clearance` text,
	`location_restriction` text,
	`licences` text,
	`other_hard_requirements` text,
	`extraction_status` text DEFAULT 'none' NOT NULL,
	`latest_extraction_id` text,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_postings_user_canonical_idx` ON `job_postings` (`user_id`,`canonical_url`);--> statement-breakpoint
CREATE INDEX `job_postings_user_external_idx` ON `job_postings` (`user_id`,`source_platform`,`external_job_id`);--> statement-breakpoint
CREATE INDEX `job_postings_user_company_idx` ON `job_postings` (`user_id`,`company_id`);--> statement-breakpoint
CREATE INDEX `job_postings_user_title_idx` ON `job_postings` (`user_id`,`title`);--> statement-breakpoint
CREATE TABLE `job_source_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_posting_id` text NOT NULL,
	`extraction_job_id` text,
	`method` text NOT NULL,
	`requested_url` text,
	`final_url` text,
	`http_status` integer,
	`content_type` text,
	`title` text,
	`text` text NOT NULL,
	`structured_data` text,
	`content_hash` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_posting_id`) REFERENCES `job_postings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_posting_idx` ON `job_source_snapshots` (`job_posting_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `job_tags` (
	`saved_job_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`saved_job_id`, `tag_id`),
	FOREIGN KEY (`saved_job_id`) REFERENCES `saved_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_tags_tag_idx` ON `job_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`saved_job_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`saved_job_id`) REFERENCES `saved_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notes_saved_job_idx` ON `notes` (`saved_job_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`saved_job_id` text,
	`kind` text DEFAULT 'custom' NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`due_at` integer NOT NULL,
	`completed_at` integer,
	`auto_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`saved_job_id`) REFERENCES `saved_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reminders_user_due_idx` ON `reminders` (`user_id`,`completed_at`,`due_at`);--> statement-breakpoint
CREATE INDEX `reminders_saved_job_idx` ON `reminders` (`saved_job_id`);--> statement-breakpoint
CREATE TABLE `saved_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_posting_id` text NOT NULL,
	`stage` text DEFAULT 'saved' NOT NULL,
	`is_starred` integer DEFAULT false NOT NULL,
	`priority` text,
	`interest_level` integer,
	`fit_assessment` text,
	`fit_score` integer,
	`next_action` text,
	`next_action_at` integer,
	`follow_up_at` integer,
	`resume_document_id` text,
	`cover_letter_document_id` text,
	`referral_contact_id` text,
	`recruiter_contact_id` text,
	`application_notes` text,
	`saved_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`archived_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_posting_id`) REFERENCES `job_postings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resume_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cover_letter_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`referral_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recruiter_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_jobs_user_posting_uq` ON `saved_jobs` (`user_id`,`job_posting_id`);--> statement-breakpoint
CREATE INDEX `saved_jobs_user_stage_idx` ON `saved_jobs` (`user_id`,`stage`);--> statement-breakpoint
CREATE INDEX `saved_jobs_user_saved_at_idx` ON `saved_jobs` (`user_id`,`saved_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_name_uq` ON `tags` (`user_id`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `user_field_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_posting_id` text NOT NULL,
	`field` text NOT NULL,
	`value` text,
	`original_value` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_posting_id`) REFERENCES `job_postings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `overrides_posting_field_uq` ON `user_field_overrides` (`job_posting_id`,`field`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`timezone` text DEFAULT 'America/Toronto' NOT NULL,
	`default_follow_up_days` integer DEFAULT 7 NOT NULL,
	`comparison_json` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);