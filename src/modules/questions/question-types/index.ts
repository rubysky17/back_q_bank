import { AppError } from '../../../lib/app-error';
import type { QuestionType } from '../../../db/schema';
import type { QuestionTypeHandler } from './question-type.handler';
import { singleChoiceHandler } from './single-choice.handler';

export type {
  QuestionSnapshot,
  QuestionTypeHandler,
} from './question-type.handler';

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
