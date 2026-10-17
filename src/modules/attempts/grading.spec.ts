import { type GradedItem, percentOf, summarize } from './grading';

const people = { id: 'd-people', name: 'People' };
const processDomain = { id: 'd-process', name: 'Process' };

function item(overrides: Partial<GradedItem>): GradedItem {
  return {
    sectionId: 's1',
    sectionTitle: 'Section 1',
    sectionOrder: 1,
    domain: people,
    difficulty: 'MEDIUM',
    points: 1,
    score: 0,
    isCorrect: false,
    answered: true,
    ...overrides,
  };
}

describe('summarize', () => {
  const items: GradedItem[] = [
    item({ score: 1, isCorrect: true, difficulty: 'EASY' }),
    item({ answered: false, difficulty: 'HARD' }),
    item({
      sectionId: 's2',
      sectionTitle: 'Section 2',
      sectionOrder: 2,
      domain: processDomain,
      points: 2,
      score: 2,
      isCorrect: true,
    }),
    item({
      sectionId: 's2',
      sectionTitle: 'Section 2',
      sectionOrder: 2,
      domain: null,
    }),
  ];

  it('computes the overall tally', () => {
    expect(summarize(items).overall).toEqual({
      total: 4,
      answered: 3,
      correct: 2,
      score: 3,
      maxScore: 5,
      percent: 60,
    });
  });

  it('breaks down by section in exam order', () => {
    const { sections } = summarize(items);
    expect(
      sections.map((s) => [s.title, s.correct, s.total, s.percent]),
    ).toEqual([
      ['Section 1', 1, 2, 50],
      ['Section 2', 1, 2, 67],
    ]);
  });

  it('breaks down by domain with unassigned questions last', () => {
    const { domains } = summarize(items);
    expect(domains.map((d) => [d.name, d.correct, d.total])).toEqual([
      ['People', 1, 2],
      ['Process', 1, 1],
      ['Unassigned', 0, 1],
    ]);
  });

  it('breaks down by difficulty from easy to hard', () => {
    const { difficulties } = summarize(items);
    expect(difficulties.map((d) => d.difficulty)).toEqual([
      'EASY',
      'MEDIUM',
      'HARD',
    ]);
  });

  it('handles a zero max score', () => {
    expect(percentOf(0, 0)).toBe(0);
  });
});
