import { AppError } from '../../../lib/app-error';
import { dragDropHandler as handler } from './drag-drop.handler';

// Ordering: put the Tuckman stages in the slots First..Third.
const definition = handler.parseDefinition({
  targets: [{ content: 'First' }, { content: 'Second' }, { content: 'Third' }],
  choices: [
    { content: 'Storming' },
    { content: 'Norming' },
    { content: 'Forming' },
  ],
  answer: [2, 0, 1],
});
const [first, second, third] = definition.targets.map((t) => t.id);
const [storming, norming, forming] = definition.choices.map((c) => c.id);

function expectBadRequest(fn: () => unknown, code: string) {
  expect(fn).toThrow(AppError);
  try {
    fn();
  } catch (error) {
    expect((error as AppError).code).toBe(code);
  }
}

describe('dragDropHandler', () => {
  it('validates the answer against targets and choices', () => {
    const base = {
      targets: [{ content: 'X' }, { content: 'Y' }],
      choices: [{ content: 'a' }, { content: 'b' }],
    };
    for (const answer of [[0], [0, 0], [0, 5]]) {
      expectBadRequest(
        () => handler.parseDefinition({ ...base, answer }),
        'INVALID_QUESTION_DEFINITION',
      );
    }
  });

  it('keys the answer by target and keeps it out of the data', () => {
    const { data, answerKey } = handler.buildSnapshot(definition, {
      shuffleOptions: true,
    });
    expect(answerKey.pairs).toEqual({
      [first]: forming,
      [second]: storming,
      [third]: norming,
    });
    expect(JSON.stringify(data)).not.toContain('answer');
    expect(data.choices.map((c) => c.id).sort()).toEqual(
      [storming, norming, forming].sort(),
    );
  });

  it('grades all-or-nothing', () => {
    const { data, answerKey } = handler.buildSnapshot(definition, {
      shuffleOptions: false,
    });
    const grade = (pairs: Record<string, string>) =>
      handler.grade(answerKey, handler.parseResponse(data, { pairs }), 1);
    expect(
      grade({ [first]: forming, [second]: storming, [third]: norming }),
    ).toEqual({ isCorrect: true, score: 1 });
    expect(grade({ [first]: forming, [second]: storming })).toEqual({
      isCorrect: false,
      score: 0,
    });
  });

  it('rejects unknown ids, a choice used twice and empty answers', () => {
    const { data } = handler.buildSnapshot(definition, {
      shuffleOptions: false,
    });
    expectBadRequest(
      () => handler.parseResponse(data, { pairs: { nope: forming } }),
      'INVALID_RESPONSE',
    );
    expectBadRequest(
      () =>
        handler.parseResponse(data, {
          pairs: { [first]: forming, [second]: forming },
        }),
      'INVALID_RESPONSE',
    );
    expectBadRequest(
      () => handler.parseResponse(data, { pairs: {} }),
      'INVALID_RESPONSE',
    );
  });
});
