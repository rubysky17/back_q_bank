import type { Difficulty } from '../../db/schema';

export interface GradedItem {
  sectionId: string | null;
  sectionTitle: string;
  sectionOrder: number;
  domain: { id: string; name: string } | null;
  difficulty: Difficulty;
  points: number;
  score: number;
  isCorrect: boolean;
  answered: boolean;
}

export interface Tally {
  total: number;
  answered: number;
  correct: number;
  score: number;
  maxScore: number;
  /** score / maxScore, rounded to a whole percent. */
  percent: number;
}

export const percentOf = (score: number, maxScore: number) =>
  maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;

function tally(items: GradedItem[]): Tally {
  const score = items.reduce((sum, item) => sum + item.score, 0);
  const maxScore = items.reduce((sum, item) => sum + item.points, 0);
  return {
    total: items.length,
    answered: items.filter((item) => item.answered).length,
    correct: items.filter((item) => item.isCorrect).length,
    score,
    maxScore,
    percent: percentOf(score, maxScore),
  };
}

function groupBy<K>(items: GradedItem[], key: (item: GradedItem) => K) {
  const groups = new Map<K, GradedItem[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

const DIFFICULTY_ORDER: Difficulty[] = ['EASY', 'MEDIUM', 'HARD', 'EXPERT'];

/** Overall result plus per-section / per-domain / per-difficulty breakdowns (strengths & weaknesses). */
export function summarize(items: GradedItem[]) {
  const sections = [...groupBy(items, (item) => item.sectionOrder).values()]
    .map((group) => ({
      sectionId: group[0].sectionId,
      title: group[0].sectionTitle,
      order: group[0].sectionOrder,
      ...tally(group),
    }))
    .sort((a, b) => a.order - b.order);

  const domains = [
    ...groupBy(items, (item) => item.domain?.id ?? null).values(),
  ]
    .map((group) => ({
      domainId: group[0].domain?.id ?? null,
      name: group[0].domain?.name ?? 'Unassigned',
      ...tally(group),
    }))
    .sort((a, b) =>
      a.domainId === null
        ? 1
        : b.domainId === null
          ? -1
          : a.name.localeCompare(b.name),
    );

  const difficulties = [...groupBy(items, (item) => item.difficulty).entries()]
    .map(([difficulty, group]) => ({ difficulty, ...tally(group) }))
    .sort(
      (a, b) =>
        DIFFICULTY_ORDER.indexOf(a.difficulty) -
        DIFFICULTY_ORDER.indexOf(b.difficulty),
    );

  return { overall: tally(items), sections, domains, difficulties };
}
