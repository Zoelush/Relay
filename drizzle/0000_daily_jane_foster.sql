CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assigned` text DEFAULT '' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`unread` integer DEFAULT 1 NOT NULL,
	`sample` integer DEFAULT 0 NOT NULL,
	`tag` text DEFAULT 'New conversation' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_conversations_updated` ON `conversations` (`updated_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`sender` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_conversation_created` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`brand` text NOT NULL,
	`greeting` text NOT NULL,
	`color` text NOT NULL,
	`availability` text NOT NULL
);
