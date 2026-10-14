import type { z } from 'zod';

import { AppError } from '../../../common/errors/app-error.js';
import type {
  Difficulty,
  QuestionType,
} from '../../../generated/prisma/client.js';

/**
 * One handler per question type. Adding a type (multiple choice, drag & drop, …) means writing a handler
 * and registering it in `question-types/index.ts` — no database migration.
 */
export interface QuestionTypeHandler<
  TDefinition = unknown,
  TData = unknown,
  TAnswerKey = unknown,
  TResponse = unknown,
> {
  readonly type: QuestionType;
  /** Validates/normalises what a host sends as `definition`. Throws AppError 400. */
  parseDefinition(input: unknown): TDefinition;
  /** Splits a definition into what the test taker sees (`data`) and the hidden `answerKey`. */
  buildSnapshot(
    definition: TDefinition,
    options: { shuffleOptions: boolean },
  ): { data: TData; answerKey: TAnswerKey };
  /** Validates a test taker's answer against the snapshot data. Throws AppError 400. */
  parseResponse(data: TData, input: unknown): TResponse;
  /** All-or-nothing for now; partial credit types can return a fraction of `points`. */
  grade(
    answerKey: TAnswerKey,
    response: TResponse,
    points: number,
  ): { isCorrect: boolean; score: number };
}

/** What gets frozen into AttemptQuestion.snapshot when an attempt starts. */
export interface QuestionSnapshot {
  type: QuestionType;
  content: string;
  explanation: string | null;
  difficulty: Difficulty;
  domain: { id: string; name: string } | null;
  data: unknown;
  answerKey: unknown;
}

/** Runs a zod schema and converts failures into a 400 with per-field details. */
export function parseWith<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: string,
  label: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    field: [label, ...issue.path.map(String)].join('.'),
    messages: [issue.message],
  }));
  const [first] = details;
  throw AppError.badRequest(
    code,
    first ? `${first.field}: ${first.messages[0]}` : `Invalid ${label}`,
    details,
  );
}
