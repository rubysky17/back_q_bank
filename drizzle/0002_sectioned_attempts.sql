-- Hand-edited. Widening the Attempt status CHECK needs a table rebuild. DROP TABLE runs an implicit
-- DELETE that fires FK actions even with deferred keys, so dropping "Attempt" while "AttemptQuestion"
-- still points at it would cascade-delete every answer. The child is therefore copied aside and
-- dropped first, then both tables are rebuilt. (D1 ignores foreign_keys=OFF.)
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_Attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`examId` text NOT NULL,
	`userId` text NOT NULL,
	`status` text DEFAULT 'IN_PROGRESS' NOT NULL,
	`mode` text DEFAULT 'LEGACY' NOT NULL,
	`phase` text,
	`currentSectionOrder` integer,
	`syncedSeq` integer DEFAULT 0 NOT NULL,
	`examTitle` text NOT NULL,
	`passingScore` integer,
	`breakMinutes` integer,
	`startedAt` integer NOT NULL,
	`expiresAt` integer,
	`submittedAt` integer,
	`abandonedAt` integer,
	`score` integer,
	`maxScore` integer NOT NULL,
	`correctCount` integer,
	`totalQuestions` integer NOT NULL,
	`passed` integer,
	FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "Attempt_status_check" CHECK("status" IN ('IN_PROGRESS', 'SUBMITTED', 'EXPIRED', 'ABANDONED')),
	CONSTRAINT "Attempt_mode_check" CHECK("mode" IN ('LEGACY', 'SECTIONED')),
	CONSTRAINT "Attempt_phase_check" CHECK("phase" IS NULL OR "phase" IN ('NOT_STARTED', 'IN_SECTION', 'IN_REVIEW', 'BREAK_OFFER', 'ON_BREAK', 'FINISHED'))
);--> statement-breakpoint
INSERT INTO `__new_Attempt`("id", "examId", "userId", "status", "examTitle", "passingScore", "startedAt", "expiresAt", "submittedAt", "score", "maxScore", "correctCount", "totalQuestions", "passed") SELECT "id", "examId", "userId", "status", "examTitle", "passingScore", "startedAt", "expiresAt", "submittedAt", "score", "maxScore", "correctCount", "totalQuestions", "passed" FROM `Attempt`;--> statement-breakpoint
CREATE TABLE `__AttemptQuestion_copy` AS SELECT "id", "attemptId", "questionId", "questionVersion", "sectionId", "sectionTitle", "sectionOrder", "order", "points", "snapshot", "response", "isCorrect", "score", "flagged", "answeredAt" FROM `AttemptQuestion`;--> statement-breakpoint
DROP TABLE `AttemptQuestion`;--> statement-breakpoint
DROP TABLE `Attempt`;--> statement-breakpoint
ALTER TABLE `__new_Attempt` RENAME TO `Attempt`;--> statement-breakpoint
CREATE INDEX `Attempt_userId_startedAt_idx` ON `Attempt` (`userId`,`startedAt`);--> statement-breakpoint
CREATE INDEX `Attempt_examId_idx` ON `Attempt` (`examId`);--> statement-breakpoint
CREATE UNIQUE INDEX `Attempt_one_in_progress_per_user_exam` ON `Attempt` (`userId`,`examId`) WHERE "status" = 'IN_PROGRESS';--> statement-breakpoint
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
	`confidence` text,
	`eliminatedOptionIds` text,
	`firstResponse` text,
	`dwellMs` integer,
	`timeToFirstAnswerMs` integer,
	`timeToFinalAnswerMs` integer,
	`visitCount` integer,
	`answerChangeCount` integer,
	`eliminationCount` integer,
	`everFlagged` integer,
	FOREIGN KEY (`attemptId`) REFERENCES `Attempt`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`questionId`) REFERENCES `Question`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "AttemptQuestion_confidence_check" CHECK("confidence" IS NULL OR "confidence" IN ('LOW', 'MEDIUM', 'HIGH'))
);--> statement-breakpoint
INSERT INTO `AttemptQuestion`("id", "attemptId", "questionId", "questionVersion", "sectionId", "sectionTitle", "sectionOrder", "order", "points", "snapshot", "response", "isCorrect", "score", "flagged", "answeredAt") SELECT "id", "attemptId", "questionId", "questionVersion", "sectionId", "sectionTitle", "sectionOrder", "order", "points", "snapshot", "response", "isCorrect", "score", "flagged", "answeredAt" FROM `__AttemptQuestion_copy`;--> statement-breakpoint
DROP TABLE `__AttemptQuestion_copy`;--> statement-breakpoint
CREATE UNIQUE INDEX `AttemptQuestion_attemptId_order_key` ON `AttemptQuestion` (`attemptId`,`order`);--> statement-breakpoint
CREATE INDEX `AttemptQuestion_questionId_idx` ON `AttemptQuestion` (`questionId`);--> statement-breakpoint
ALTER TABLE `ExamSection` ADD `durationMinutes` integer;--> statement-breakpoint
ALTER TABLE `Exam` ADD `breakMinutes` integer;--> statement-breakpoint
CREATE TABLE `AttemptEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`attemptId` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`sectionOrder` integer NOT NULL,
	`attemptQuestionId` text,
	`payload` text,
	`activeMs` integer NOT NULL,
	`clientAt` integer NOT NULL,
	`receivedAt` integer NOT NULL,
	FOREIGN KEY (`attemptId`) REFERENCES `Attempt`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "AttemptEvent_type_check" CHECK("type" IN ('SECTION_START', 'SECTION_PAUSE', 'SECTION_RESUME', 'SECTION_REVIEW_OPEN', 'SECTION_END', 'BREAK_START', 'BREAK_SKIP', 'BREAK_END', 'QUESTION_VIEW', 'QUESTION_LEAVE', 'OPTION_ELIMINATE', 'OPTION_RESTORE', 'ANSWER_SELECT', 'ANSWER_CLEAR', 'CONFIDENCE_SET', 'FLAG_SET', 'ATTEMPT_SUBMIT', 'ATTEMPT_ABANDON'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `AttemptEvent_attemptId_seq_key` ON `AttemptEvent` (`attemptId`,`seq`);--> statement-breakpoint
CREATE TABLE `AttemptSection` (
	`id` text PRIMARY KEY NOT NULL,
	`attemptId` text NOT NULL,
	`sectionId` text,
	`sectionOrder` integer NOT NULL,
	`budgetMs` integer NOT NULL,
	`usedMs` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'LOCKED' NOT NULL,
	`startedAt` integer,
	`endedAt` integer,
	`endReason` text,
	`breakTakenMs` integer,
	`breakSkipped` integer,
	FOREIGN KEY (`attemptId`) REFERENCES `Attempt`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "AttemptSection_status_check" CHECK("status" IN ('LOCKED', 'ACTIVE', 'COMPLETED')),
	CONSTRAINT "AttemptSection_endReason_check" CHECK("endReason" IS NULL OR "endReason" IN ('USER', 'TIME_UP'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `AttemptSection_attemptId_sectionOrder_key` ON `AttemptSection` (`attemptId`,`sectionOrder`);--> statement-breakpoint
PRAGMA defer_foreign_keys = off;