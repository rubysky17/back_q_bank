import { AppError } from '../../../lib/app-error';
import { multipleChoiceHandler as handler } from './multiple-choice.handler';

const definition = handler.parseDefinition({
  options: [
    { content: 'Hold a retrospective', isCorrect: true },
    { content: 'Escalate to the sponsor', isCorrect: false },
    { content: 'Update the lessons learned register', isCorrect: true },
    { content: 'Ignore it', isCorrect: false },
  ],
});
const [a, b, c] = definition.options.map((option) => option.id);

function expectBadRequest(fn: () => unknown, code: string) {
  expect(fn).toThrow(AppError);
  try {
    fn();
  } catch (error) {
    expect((error as AppError).code).toBe(code);
  }
}

describe('multipleChoiceHandler', () => {
  it('requires at least two correct options and at least one wrong one', () => {
    expectBadRequest(
      () =>
        handler.parseDefinition({
          options: [
            { content: 'A', isCorrect: true },
            { content: 'B', isCorrect: false },
            { content: 'C', isCorrect: false },
          ],
        }),
      'INVALID_QUESTION_DEFINITION',
    );
    expectBadRequest(
      () =>
        handler.parseDefinition({
          options: [
            { content: 'A', isCorrect: true },
            { content: 'B', isCorrect: true },
            { content: 'C', isCorrect: true },
          ],
        }),
      'INVALID_QUESTION_DEFINITION',
    );
  });

  it('tells how many to select and hides the key', () => {
    const { data, answerKey } = handler.buildSnapshot(definition, {
      shuffleOptions: false,
    });
    expect(data.selectCount).toBe(2);
    expect(JSON.stringify(data)).not.toContain('isCorrect');
    expect(answerKey.correctOptionIds).toEqual([a, c]);
  });

  it('grades the exact set only', () => {
    const { data, answerKey } = handler.buildSnapshot(definition, {
      shuffleOptions: true,
    });
    const grade = (optionIds: string[]) =>
      handler.grade(answerKey, handler.parseResponse(data, { optionIds }), 2);
    expect(grade([c, a])).toEqual({ isCorrect: true, score: 2 });
    expect(grade([a])).toEqual({ isCorrect: false, score: 0 });
    expect(grade([a, b])).toEqual({ isCorrect: false, score: 0 });
  });

  it('rejects unknown, repeated or too many options', () => {
    const { data } = handler.buildSnapshot(definition, {
      shuffleOptions: false,
    });
    expectBadRequest(
      () => handler.parseResponse(data, { optionIds: ['nope'] }),
      'INVALID_RESPONSE',
    );
    expectBadRequest(
      () => handler.parseResponse(data, { optionIds: [a, a] }),
      'INVALID_RESPONSE',
    );
    expectBadRequest(
      () => handler.parseResponse(data, { optionIds: [a, b, c] }),
      'INVALID_RESPONSE',
    );
  });
});
