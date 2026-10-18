import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AppError } from '../../../lib/app-error';
import { shuffle } from '../../../lib/random';
import { parseWith, type QuestionTypeHandler } from './question-type.handler';

const MIN_OPTIONS = 3;
const MAX_OPTIONS = 10;

/** "Select two": several correct options; the test taker is told how many to pick. */
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
    if (correct < 2 || correct >= options.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: `between 2 and ${options.length - 1} options must be correct (found ${correct})`,
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

export interface MultipleChoiceDefinition {
  options: { id: string; content: string; isCorrect: boolean }[];
}
export interface MultipleChoiceData {
  options: { id: string; content: string }[];
  /** How many options to select ("Select two"). */
  selectCount: number;
}
export interface MultipleChoiceAnswerKey {
  correctOptionIds: string[];
}
export interface MultipleChoiceResponse {
  optionIds: string[];
}

const responseSchema = z
  .object({ optionIds: z.array(z.string().min(1)).min(1).max(MAX_OPTIONS) })
  .strict();

export const multipleChoiceHandler: QuestionTypeHandler<
  MultipleChoiceDefinition,
  MultipleChoiceData,
  MultipleChoiceAnswerKey,
  MultipleChoiceResponse
> = {
  type: 'MULTIPLE_CHOICE',

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
    const correctOptionIds = definition.options
      .filter((option) => option.isCorrect)
      .map((option) => option.id);
    return {
      data: {
        options: options.map(({ id, content }) => ({ id, content })),
        selectCount: correctOptionIds.length,
      },
      answerKey: { correctOptionIds },
    };
  },

  parseResponse(data, input) {
    const response = parseWith(
      responseSchema,
      input,
      'INVALID_RESPONSE',
      'response',
    );
    const known = new Set(data.options.map((option) => option.id));
    const ids = [...new Set(response.optionIds)];
    if (ids.length !== response.optionIds.length) {
      throw AppError.badRequest(
        'INVALID_RESPONSE',
        'response.optionIds must not repeat an option',
      );
    }
    if (!ids.every((id) => known.has(id))) {
      throw AppError.badRequest(
        'INVALID_RESPONSE',
        'response.optionIds contains an option that is not part of the question',
      );
    }
    if (ids.length > data.selectCount) {
      throw AppError.badRequest(
        'INVALID_RESPONSE',
        `Select at most ${data.selectCount} options`,
      );
    }
    return { optionIds: ids };
  },

  /** All-or-nothing: exactly the correct set. */
  grade(answerKey, response, points) {
    const picked = new Set(response.optionIds);
    const isCorrect =
      picked.size === answerKey.correctOptionIds.length &&
      answerKey.correctOptionIds.every((id) => picked.has(id));
    return { isCorrect, score: isCorrect ? points : 0 };
  },
};
