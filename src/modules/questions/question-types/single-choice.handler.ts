import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AppError } from '../../../common/errors/app-error.js';
import { shuffle } from '../../../common/utils/random.js';
import { QuestionType } from '../../../generated/prisma/client.js';
import {
  parseWith,
  type QuestionTypeHandler,
} from './question-type.handler.js';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

const definitionSchema = z
  .object({
    options: z
      .array(
        z
          .object({
            /** Keep the id when editing so existing references stay stable; omit for new options. */
            id: z.string().trim().min(1).max(64).optional(),
            content: z.string().trim().min(1).max(2000),
            isCorrect: z.boolean(),
          })
          .strict(),
      )
      .min(MIN_OPTIONS)
      .max(MAX_OPTIONS),
  })
  .strict()
  .superRefine(({ options }, ctx) => {
    const correct = options.filter((option) => option.isCorrect).length;
    if (correct !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: `exactly one option must be correct (found ${correct})`,
      });
    }
    const contents = options.map((option) => option.content.toLowerCase());
    if (new Set(contents).size !== contents.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'options must not repeat the same content',
      });
    }
    const ids = options.flatMap((option) => (option.id ? [option.id] : []));
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'option ids must be unique',
      });
    }
  });

export interface SingleChoiceDefinition {
  options: { id: string; content: string; isCorrect: boolean }[];
}
export interface SingleChoiceData {
  options: { id: string; content: string }[];
}
export interface SingleChoiceAnswerKey {
  correctOptionId: string;
}
export interface SingleChoiceResponse {
  optionId: string;
}

const responseSchema = z.object({ optionId: z.string().min(1) }).strict();

export const singleChoiceHandler: QuestionTypeHandler<
  SingleChoiceDefinition,
  SingleChoiceData,
  SingleChoiceAnswerKey,
  SingleChoiceResponse
> = {
  type: QuestionType.SINGLE_CHOICE,

  parseDefinition(input) {
    const parsed = parseWith(
      definitionSchema,
      input,
      'INVALID_QUESTION_DEFINITION',
      'definition',
    );
    return {
      options: parsed.options.map((option) => ({
        id: option.id ?? randomUUID(),
        content: option.content,
        isCorrect: option.isCorrect,
      })),
    };
  },

  buildSnapshot(definition, { shuffleOptions }) {
    const options = shuffleOptions
      ? shuffle(definition.options)
      : definition.options;
    const correct = definition.options.find((option) => option.isCorrect);
    if (!correct)
      throw new Error('Single choice question has no correct option');
    return {
      data: { options: options.map(({ id, content }) => ({ id, content })) },
      answerKey: { correctOptionId: correct.id },
    };
  },

  parseResponse(data, input) {
    const response = parseWith(
      responseSchema,
      input,
      'INVALID_RESPONSE',
      'response',
    );
    if (!data.options.some((option) => option.id === response.optionId)) {
      throw AppError.badRequest(
        'INVALID_RESPONSE',
        'response.optionId is not one of the question options',
      );
    }
    return response;
  },

  grade(answerKey, response, points) {
    const isCorrect = response.optionId === answerKey.correctOptionId;
    return { isCorrect, score: isCorrect ? points : 0 };
  },
};
