CREATE TABLE `CaseStudy` (
	`id` text PRIMARY KEY NOT NULL,
	`topicId` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`createdById` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`topicId`) REFERENCES `Topic`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `CaseStudy_topicId_idx` ON `CaseStudy` (`topicId`);--> statement-breakpoint
-- D1 ignores foreign_keys=OFF; deferring keeps the rebuild of "Question" from tripping the FKs that point at it.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
-- DROP TABLE runs the ON DELETE SET NULL action of AttemptQuestion.questionId: keep the links and restore them below.
CREATE TABLE `__AttemptQuestion_links` AS SELECT "id", "questionId" FROM `AttemptQuestion` WHERE "questionId" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_Question` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`topicId` text NOT NULL,
	`domainId` text,
	`caseStudyId` text,
	`type` text DEFAULT 'SINGLE_CHOICE' NOT NULL,
	`difficulty` text DEFAULT 'MEDIUM' NOT NULL,
	`content` text NOT NULL,
	`searchText` text NOT NULL,
	`explanation` text,
	`media` text DEFAULT '[]' NOT NULL,
	`definition` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`topicId`) REFERENCES `Topic`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`domainId`) REFERENCES `Domain`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`caseStudyId`) REFERENCES `CaseStudy`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "Question_type_check" CHECK("type" IN ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'POINT_CHOICE', 'DRAG_DROP', 'CALCULATION')),
	CONSTRAINT "Question_difficulty_check" CHECK("difficulty" IN ('EASY', 'MEDIUM', 'HARD', 'EXPERT'))
);
--> statement-breakpoint
INSERT INTO `__new_Question`("id", "ownerId", "topicId", "domainId", "caseStudyId", "type", "difficulty", "content", "searchText", "explanation", "media", "definition", "version", "createdAt", "updatedAt") SELECT "id", "ownerId", "topicId", "domainId", NULL, "type", "difficulty", "content", "searchText", "explanation", '[]', "definition", "version", "createdAt", "updatedAt" FROM `Question`;--> statement-breakpoint
DROP TABLE `Question`;--> statement-breakpoint
ALTER TABLE `__new_Question` RENAME TO `Question`;--> statement-breakpoint
UPDATE `AttemptQuestion` SET "questionId" = (SELECT l."questionId" FROM `__AttemptQuestion_links` l WHERE l."id" = `AttemptQuestion`."id") WHERE "id" IN (SELECT "id" FROM `__AttemptQuestion_links`);--> statement-breakpoint
DROP TABLE `__AttemptQuestion_links`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;--> statement-breakpoint
CREATE INDEX `Question_ownerId_topicId_idx` ON `Question` (`ownerId`,`topicId`);--> statement-breakpoint
CREATE INDEX `Question_topicId_domainId_difficulty_idx` ON `Question` (`topicId`,`domainId`,`difficulty`);--> statement-breakpoint
CREATE INDEX `Question_caseStudyId_idx` ON `Question` (`caseStudyId`);--> statement-breakpoint
ALTER TABLE `ExamQuestion` ADD `sourceNumber` integer;