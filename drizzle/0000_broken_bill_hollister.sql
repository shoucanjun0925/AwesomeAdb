CREATE TABLE `adb_paths` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`path` text NOT NULL,
	`path_key` text NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `adb_path_owner_key` ON `adb_paths` (`user_id`,`machine_id`,`path_key`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint_key` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`mode` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_owner_key` ON `connections` (`user_id`,`endpoint_key`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`mode` text NOT NULL,
	`last_path` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preference_owner_machine` ON `preferences` (`user_id`,`machine_id`);