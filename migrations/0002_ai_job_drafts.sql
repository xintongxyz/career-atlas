CREATE TABLE `job_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`origin` text DEFAULT 'paste' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source_url` text,
	`description_text` text,
	`result` text NOT NULL,
	`notes` text,
	`saved_job_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`saved_job_id`) REFERENCES `saved_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `job_drafts_user_status_idx` ON `job_drafts` (`user_id`,`status`,`created_at`);