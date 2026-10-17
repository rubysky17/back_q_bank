ALTER TABLE `AttemptQuestion` ADD `timeSpentMs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `Attempt_userId_examId_startedAt_idx` ON `Attempt` (`userId`,`examId`,`startedAt`);