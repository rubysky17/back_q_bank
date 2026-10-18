import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AppError } from '../../../lib/app-error';
import { shuffle } from '../../../lib/random';
import { parseWith, type QuestionTypeHandler } from './question-type.handler';

const MAX_ITEMS = 10;

const item = z
  .object({
    /** Keep the id when editing; omit for new items. */
    id: z.string().trim().min(1).max(64).optional(),
    content: z.string().trim().min(1).max(2000),
  })
  .strict();

/**
 * Drag and drop: put one choice in each target. Covers matching (terms → definitions) and ordering
 * (stages → "First", "Second", …). `answer[i]` is the index in `choices` that belongs in `targets[i]`.
 */
const definitionSchema = z
  .object({
    targets: z.array(item).min(2).max(MAX_ITEMS),
    choices: z.array(item).min(2).max(MAX_ITEMS),
    answer: z.array(z.number().int().min(0)),
  })
  .strict()
  .superRefine(({ targets, choices, answer }, ctx) => {
    if (answer.length !== targets.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['answer'],
        message: 'answer needs one choice index per target',
      });
    }
    if (answer.some((index) => index >= choices.length)) {
      ctx.addIssue({
        code: 'custom',
        path: ['answer'],
        message: 'answer refers to a choice that does not exist',
      });
    }
    if (new Set(answer).size !== answer.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['answer'],
        message: 'a choice can go in only one target',
      });
    }
    const ids = [...targets, ...choices].flatMap((i) => (i.id ? [i.id] : []));
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'target and choice ids must be unique',
      });
    }
  });

type Item = { id: string; content: string };

export interface DragDropDefinition {
  targets: Item[];
  choices: Item[];
  answer: number[];
}
export interface DragDropData {
  targets: Item[];
  choices: Item[];
}
export interface DragDropAnswerKey {
  /** targetId → choiceId */
  pairs: Record<string, string>;
}
export interface DragDropResponse {
  /** targetId → choiceId; targets left empty are omitted. */
  pairs: Record<string, string>;
}

const responseSchema = z
  .object({ pairs: z.record(z.string().min(1), z.string().min(1)) })
  .strict();

export const dragDropHandler: QuestionTypeHandler<
  DragDropDefinition,
  DragDropData,
  DragDropAnswerKey,
  DragDropResponse
> = {
  type: 'DRAG_DROP',

  parseDefinition(input) {
    const parsed = parseWith(
      definitionSchema,
      input,
      'INVALID_QUESTION_DEFINITION',
      'definition',
    );
    const withId = (i: { id?: string; content: string }) => ({
      id: i.id ?? randomUUID(),
      content: i.content,
    });
    return {
      targets: parsed.targets.map(withId),
      choices: parsed.choices.map(withId),
      answer: parsed.answer,
    };
  },

  buildSnapshot(definition, { shuffleOptions }) {
    const pairs: Record<string, string> = {};
    definition.targets.forEach((target, i) => {
      pairs[target.id] = definition.choices[definition.answer[i]].id;
    });
    return {
      data: {
        targets: definition.targets,
        choices: shuffleOptions
          ? shuffle(definition.choices)
          : definition.choices,
      },
      answerKey: { pairs },
    };
  },

  parseResponse(data, input) {
    const { pairs } = parseWith(
      responseSchema,
      input,
      'INVALID_RESPONSE',
      'response',
    );
    const targets = new Set(data.targets.map((t) => t.id));
    const choices = new Set(data.choices.map((c) => c.id));
    const used = Object.values(pairs);
    if (
      !Object.keys(pairs).every((id) => targets.has(id)) ||
      !used.every((id) => choices.has(id))
    ) {
      throw AppError.badRequest(
        'INVALID_RESPONSE',
        'response.pairs refers to a target or choice that is not part of the question',
      );
    }
    if (new Set(used).size !== used.length) {
      throw AppError.badRequest(
        'INVALID_RESPONSE',
        'Each choice can go in only one target',
      );
    }
    if (used.length === 0) {
      throw AppError.badRequest(
        'INVALID_RESPONSE',
        'response.pairs is empty; send null to clear the answer',
      );
    }
    return { pairs };
  },

  /** All-or-nothing: every target holds its choice. */
  grade(answerKey, response, points) {
    const isCorrect = Object.entries(answerKey.pairs).every(
      ([targetId, choiceId]) => response.pairs[targetId] === choiceId,
    );
    return { isCorrect, score: isCorrect ? points : 0 };
  },
};
