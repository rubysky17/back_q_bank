CREATE TABLE `TermTranslation` (
	`termKey` text PRIMARY KEY NOT NULL,
	`meaning` text NOT NULL,
	`partOfSpeech` text,
	`explanation` text,
	`model` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `VocabNote` (
	`userId` text NOT NULL,
	`termKey` text NOT NULL,
	`term` text NOT NULL,
	`kind` text NOT NULL,
	`meaning` text,
	`partOfSpeech` text,
	`explanation` text,
	`context` text,
	`sourceTitle` text,
	`translateTries` integer DEFAULT 0 NOT NULL,
	`clientUpdatedAt` integer NOT NULL,
	`rev` integer NOT NULL,
	`deletedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `termKey`),
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "VocabNote_kind_check" CHECK("kind" IN ('WORD', 'PHRASE', 'SENTENCE'))
);
--> statement-breakpoint
CREATE INDEX `VocabNote_userId_rev_termKey_idx` ON `VocabNote` (`userId`,`rev`,`termKey`);--> statement-breakpoint
CREATE INDEX `VocabNote_pending_idx` ON `VocabNote` (`userId`,`rev`) WHERE "meaning" IS NULL AND "deletedAt" IS NULL;