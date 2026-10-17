CREATE TABLE `AttemptQuestion` (
	`id` text PRIMARY KEY NOT NULL,
	`attemptId` text NOT NULL,
	`questionId` text,
	`questionVersion` integer NOT NULL,
	`sectionId` text,
	`sectionTitle` text NOT NULL,
	`sectionOrder` integer NOT NULL,
	`order` integer NOT NULL,
	`points` integer NOT NULL,
	`snapshot` text NOT NULL,
	`response` text,
	`isCorrect` integer,
	`score` integer,
	`flagged` integer DEFAULT false NOT NULL,
	`answeredAt` integer,
	FOREIGN KEY (`attemptId`) REFERENCES `Attempt`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`questionId`) REFERENCES `Question`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `AttemptQuestion_attemptId_order_key` ON `AttemptQuestion` (`attemptId`,`order`);--> statement-breakpoint
CREATE INDEX `AttemptQuestion_questionId_idx` ON `AttemptQuestion` (`questionId`);--> statement-breakpoint
CREATE TABLE `Attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`examId` text NOT NULL,
	`userId` text NOT NULL,
	`status` text DEFAULT 'IN_PROGRESS' NOT NULL,
	`examTitle` text NOT NULL,
	`passingScore` integer,
	`startedAt` integer NOT NULL,
	`expiresAt` integer,
	`submittedAt` integer,
	`score` integer,
	`maxScore` integer NOT NULL,
	`correctCount` integer,
	`totalQuestions` integer NOT NULL,
	`passed` integer,
	FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "Attempt_status_check" CHECK("status" IN ('IN_PROGRESS', 'SUBMITTED', 'EXPIRED'))
);
--> statement-breakpoint
CREATE INDEX `Attempt_userId_startedAt_idx` ON `Attempt` (`userId`,`startedAt`);--> statement-breakpoint
CREATE INDEX `Attempt_examId_idx` ON `Attempt` (`examId`);--> statement-breakpoint
CREATE UNIQUE INDEX `Attempt_one_in_progress_per_user_exam` ON `Attempt` (`userId`,`examId`) WHERE "status" = 'IN_PROGRESS';--> statement-breakpoint
CREATE TABLE `Domain` (
	`id` text PRIMARY KEY NOT NULL,
	`topicId` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`order` integer DEFAULT 0 NOT NULL,
	`createdById` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`topicId`) REFERENCES `Topic`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Domain_topicId_name_key` ON `Domain` (`topicId`,`name`);--> statement-breakpoint
CREATE TABLE `ExamQuestion` (
	`id` text PRIMARY KEY NOT NULL,
	`examId` text NOT NULL,
	`sectionId` text NOT NULL,
	`questionId` text NOT NULL,
	`order` integer NOT NULL,
	`points` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`sectionId`,`examId`) REFERENCES `ExamSection`(`id`,`examId`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`questionId`) REFERENCES `Question`(`id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `ExamQuestion_sectionId_order_idx` ON `ExamQuestion` (`sectionId`,`order`);--> statement-breakpoint
CREATE INDEX `ExamQuestion_questionId_idx` ON `ExamQuestion` (`questionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `ExamQuestion_examId_questionId_key` ON `ExamQuestion` (`examId`,`questionId`);--> statement-breakpoint
CREATE TABLE `ExamSection` (
	`id` text PRIMARY KEY NOT NULL,
	`examId` text NOT NULL,
	`title` text NOT NULL,
	`order` integer NOT NULL,
	`instructions` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ExamSection_examId_order_idx` ON `ExamSection` (`examId`,`order`);--> statement-breakpoint
CREATE UNIQUE INDEX `ExamSection_id_examId_key` ON `ExamSection` (`id`,`examId`);--> statement-breakpoint
CREATE TABLE `Exam` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`topicId` text NOT NULL,
	`title` text NOT NULL,
	`searchText` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`durationMinutes` integer,
	`passingScore` integer,
	`shuffleQuestions` integer DEFAULT false NOT NULL,
	`shuffleOptions` integer DEFAULT false NOT NULL,
	`publishedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`topicId`) REFERENCES `Topic`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "Exam_status_check" CHECK("status" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'))
);
--> statement-breakpoint
CREATE INDEX `Exam_ownerId_idx` ON `Exam` (`ownerId`);--> statement-breakpoint
CREATE INDEX `Exam_status_topicId_idx` ON `Exam` (`status`,`topicId`);--> statement-breakpoint
CREATE TABLE `Question` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`topicId` text NOT NULL,
	`domainId` text,
	`type` text DEFAULT 'SINGLE_CHOICE' NOT NULL,
	`difficulty` text DEFAULT 'MEDIUM' NOT NULL,
	`content` text NOT NULL,
	`searchText` text NOT NULL,
	`explanation` text,
	`definition` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`topicId`) REFERENCES `Topic`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`domainId`) REFERENCES `Domain`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "Question_type_check" CHECK("type" IN ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'POINT_CHOICE', 'DRAG_DROP', 'CALCULATION')),
	CONSTRAINT "Question_difficulty_check" CHECK("difficulty" IN ('EASY', 'MEDIUM', 'HARD'))
);
--> statement-breakpoint
CREATE INDEX `Question_ownerId_topicId_idx` ON `Question` (`ownerId`,`topicId`);--> statement-breakpoint
CREATE INDEX `Question_topicId_domainId_difficulty_idx` ON `Question` (`topicId`,`domainId`,`difficulty`);--> statement-breakpoint
CREATE TABLE `Session` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`secretHash` text NOT NULL,
	`prevSecretHash` text,
	`rotatedAt` integer,
	`deviceId` text,
	`deviceName` text,
	`platform` text,
	`userAgent` text,
	`ip` text,
	`expiresAt` integer NOT NULL,
	`revokedAt` integer,
	`lastUsedAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "Session_platform_check" CHECK("platform" IS NULL OR "platform" IN ('IOS', 'ANDROID', 'WEB'))
);
--> statement-breakpoint
CREATE INDEX `Session_userId_deviceId_idx` ON `Session` (`userId`,`deviceId`);--> statement-breakpoint
CREATE TABLE `Topic` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`createdById` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Topic_slug_key` ON `Topic` (`slug`);--> statement-breakpoint
CREATE TABLE `User` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`passwordHash` text NOT NULL,
	`fullName` text NOT NULL,
	`role` text DEFAULT 'USER' NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	CONSTRAINT "User_role_check" CHECK("role" IN ('USER', 'HOST', 'ADMIN'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `User_email_key` ON `User` (`email`);