import { AppError } from '../../../common/errors/app-error.js';
import { getQuestionTypeHandler } from './index.js';
import { singleChoiceHandler as handler } from './single-choice.handler.js';

const validInput = {
  options: [
    { content: 'Escalate to the sponsor', isCorrect: false },
    { content: 'Meet both team members', isCorrect: true },
    { id: 'keep-me', content: 'Reassign one of them', isCorrect: false },
  ],
};

function expectBadRequest(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    expect((error as AppError).getStatus()).toBe(400);
    return;
  }
  throw new Error('expected an AppError');
}

describe('singleChoiceHandler', () => {
  describe('parseDefinition', () => {
    it('assigns ids to new options and keeps existing ones', () => {
      const definition = handler.parseDefinition(validInput);
      expect(definition.options).toHaveLength(3);
      expect(definition.options[2].id).toBe('keep-me');
      expect(definition.options[0].id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it.each([
      [
        'fewer than 2 options',
        { options: [{ content: 'A', isCorrect: true }] },
      ],
      [
        'no correct option',
        {
          options: [
            { content: 'A', isCorrect: false },
            { content: 'B', isCorrect: false },
          ],
        },
      ],
      [
        'two correct options',
        {
          options: [
            { content: 'A', isCorrect: true },
            { content: 'B', isCorrect: true },
          ],
        },
      ],
      [
        'duplicate content',
        {
          options: [
            { content: 'Same', isCorrect: true },
            { content: ' same ', isCorrect: false },
          ],
        },
      ],
      [
        'unknown keys',
        {
          options: [
            { content: 'A', isCorrect: true },
            { content: 'B', isCorrect: false },
          ],
          extra: 1,
        },
      ],
      ['not an object', 'nope'],
    ])('rejects %s', (_label, input) => {
      expectBadRequest(
        () => handler.parseDefinition(input),
        'INVALID_QUESTION_DEFINITION',
      );
    });
  });

  describe('snapshot, response and grading', () => {
    const definition = handler.parseDefinition(validInput);
    const correctId = definition.options[1].id;
    const wrongId = definition.options[0].id;

    it('hides the answer key from the public data', () => {
      const { data, answerKey } = handler.buildSnapshot(definition, {
        shuffleOptions: false,
      });
      expect(answerKey).toEqual({ correctOptionId: correctId });
      expect(data.options).toEqual(
        definition.options.map(({ id, content }) => ({ id, content })),
      );
      expect(JSON.stringify(data)).not.toContain('isCorrect');
    });

    it('keeps the same options when shuffling', () => {
      const { data } = handler.buildSnapshot(definition, {
        shuffleOptions: true,
      });
      expect(data.options.map((option) => option.id).sort()).toEqual(
        definition.options.map((option) => option.id).sort(),
      );
    });

    it('grades all-or-nothing', () => {
      const { data, answerKey } = handler.buildSnapshot(definition, {
        shuffleOptions: false,
      });
      const right = handler.parseResponse(data, { optionId: correctId });
      const wrong = handler.parseResponse(data, { optionId: wrongId });
      expect(handler.grade(answerKey, right, 3)).toEqual({
        isCorrect: true,
        score: 3,
      });
      expect(handler.grade(answerKey, wrong, 3)).toEqual({
        isCorrect: false,
        score: 0,
      });
    });

    it('rejects responses for options that do not exist', () => {
      const { data } = handler.buildSnapshot(definition, {
        shuffleOptions: false,
      });
      expectBadRequest(
        () => handler.parseResponse(data, { optionId: 'missing' }),
        'INVALID_RESPONSE',
      );
      expectBadRequest(
        () => handler.parseResponse(data, {}),
        'INVALID_RESPONSE',
      );
    });
  });

  it('reports unsupported question types', () => {
    expectBadRequest(
      () => getQuestionTypeHandler('DRAG_DROP'),
      'QUESTION_TYPE_NOT_SUPPORTED',
    );
  });
});
