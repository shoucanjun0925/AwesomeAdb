CREATE TABLE `device_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`binding_key` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `device_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_binding_owner_key` ON `device_bindings` (`user_id`,`binding_key`);--> statement-breakpoint
CREATE TABLE `device_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `connections` ADD `device_id` text;
