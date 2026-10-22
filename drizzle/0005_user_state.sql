CREATE TABLE `UserItem` (
	`userId` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`clientUpdatedAt` integer NOT NULL,
	`rev` integer NOT NULL,
	`deletedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `kind`, `key`),
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "UserItem_kind_check" CHECK("kind" IN ('PRACTICE', 'SETTING'))
);
--> statement-breakpoint
CREATE INDEX `UserItem_userId_rev_kind_key_idx` ON `UserItem` (`userId`,`rev`,`kind`,`key`);--> statement-breakpoint
ALTER TABLE `AttemptQuestion` ADD `clientUpdatedAt` integer;--> statement-breakpoint
ALTER TABLE `Attempt` ADD `updatedAt` integer;--> statement-breakpoint
UPDATE `Attempt` SET `updatedAt` = coalesce(`submittedAt`, `abandonedAt`, `startedAt`);
