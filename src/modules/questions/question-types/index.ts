import { AppError } from '../../../common/errors/app-error.js';
import type { QuestionType } from '../../../generated/prisma/client.js';
import type { QuestionTypeHandler } from './question-type.handler.js';
import { singleChoiceHandler } from './single-choice.handler.js';

export type {
  QuestionSnapshot,
  QuestionTypeHandler,
} from './question-type.handler.js';

const handlers: Partial<
  Record<QuestionType, QuestionTypeHandler<any, any, any, any>>
> = {
  SINGLE_CHOICE: singleChoiceHandler,
};

export const supportedQuestionTypes = Object.keys(handlers) as QuestionType[];

export function getQuestionTypeHandler(
  type: QuestionType,
): QuestionTypeHandler<any, any, any, any> {
  const handler = handlers[type];
  if (!handler) {
    throw AppError.badRequest(
      'QUESTION_TYPE_NOT_SUPPORTED',
      `Question type ${type} is not supported yet (supported: ${supportedQuestionTypes.join(', ')})`,
    );
  }
  return handler;
}
