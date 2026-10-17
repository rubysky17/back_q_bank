import { MAX_ANSWER_TIME_MS } from '../attempts/service';
import {
  type AttemptStatRow,
  buildReport,
  type DomainStatRow,
} from './service';

const start = new Date('2026-10-01T08:00:00.000Z');
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

function attempt(overrides: Partial<AttemptStatRow>): AttemptStatRow {
  return {
    id: 'a1',
    examId: 'e1',
    examTitle: 'PMP Mock',
    status: 'SUBMITTED',
    startedAt: start,
    expiresAt: at(30),
    submittedAt: at(10),
    correctCount: 2,
    totalQuestions: 4,
    answered: 3,
    timedCount: 3,
    timedMs: 30_000,
    ...overrides,
  };
}

function domain(overrides: Partial<DomainStatRow>): DomainStatRow {
  return {
    examId: 'e1',
    domainId: 'd-people',
    name: 'People',
    total: 4,
    correct: 2,
    answered: 3,
    timedCount: 3,
    timedMs: 30_000,
    ...overrides,
  };
}

describe('buildReport', () => {
  it('pools % correct over attempts and keeps latest and best', () => {
    const report = buildReport(
      'e1',
      [
        attempt({ id: 'a1', correctCount: 1, totalQuestions: 4, answered: 4 }),
        attempt({ id: 'a2', correctCount: 6, totalQuestions: 6, answered: 6 }),
        attempt({ id: 'a3', correctCount: 1, totalQuestions: 2, answered: 1 }),
      ],
      [],
    );
    expect(report.attempts.map((a) => a.correctPercent)).toEqual([25, 100, 50]);
    expect(report.summary).toMatchObject({
      attemptCount: 3,
      // 8 / 12, not the mean of the three percents.
      avgCorrectPercent: 67,
      latestCorrectPercent: 50,
      bestCorrectPercent: 100,
      outcomes: { total: 12, correct: 8, wrong: 3, unanswered: 1 },
    });
  });

  it('takes the title from the newest attempt', () => {
    const report = buildReport(
      'e1',
      [
        attempt({ examTitle: 'Old title' }),
        attempt({ examTitle: 'New title' }),
      ],
      [],
    );
    expect(report.examTitle).toBe('New title');
  });

  it('averages measured time over timed answers only', () => {
    const report = buildReport(
      'e1',
      [
        attempt({ timedCount: 2, timedMs: 20_000 }),
        attempt({ timedCount: 3, timedMs: 60_000 }),
      ],
      [],
    );
    expect(report.attempts.map((a) => a.avgTimePerAnswerMs)).toEqual([
      10_000, 20_000,
    ]);
    expect(report.attempts.every((a) => !a.timeEstimated)).toBe(true);
    expect(report.summary).toMatchObject({
      avgTimePerAnswerMs: 16_000,
      timeSource: 'measured',
    });
  });

  it('estimates time from the duration for attempts recorded before timing existed', () => {
    const report = buildReport(
      'e1',
      [attempt({ answered: 4, timedCount: 0, timedMs: 0, submittedAt: at(8) })],
      [],
    );
    expect(report.attempts[0]).toMatchObject({
      durationSeconds: 480,
      avgTimePerAnswerMs: 120_000,
      timeEstimated: true,
    });
    expect(report.summary.timeSource).toBe('estimated');
  });

  it('weights a mix of measured and estimated attempts by answers', () => {
    const report = buildReport(
      'e1',
      [
        attempt({ answered: 2, timedCount: 0, timedMs: 0, submittedAt: at(2) }),
        attempt({ timedCount: 2, timedMs: 20_000 }),
      ],
      [],
    );
    // (2 × 60s + 20s) / 4 answers
    expect(report.summary).toMatchObject({
      avgTimePerAnswerMs: 35_000,
      timeSource: 'mixed',
    });
  });

  it('ends an expired attempt at its deadline, not when the server closed it', () => {
    const report = buildReport(
      'e1',
      [
        attempt({
          status: 'EXPIRED',
          expiresAt: at(30),
          submittedAt: at(60 * 24),
          answered: 3,
          timedCount: 0,
          timedMs: 0,
        }),
      ],
      [],
    );
    expect(report.attempts[0]).toMatchObject({
      durationSeconds: 1800,
      avgTimePerAnswerMs: 600_000,
    });
  });

  it('caps the estimate per answer', () => {
    const report = buildReport(
      'e1',
      [
        attempt({
          expiresAt: null,
          submittedAt: at(120),
          answered: 2,
          timedCount: 0,
          timedMs: 0,
        }),
      ],
      [],
    );
    expect(report.attempts[0]!.avgTimePerAnswerMs).toBe(MAX_ANSWER_TIME_MS);
  });

  it('has no time when nothing was answered', () => {
    const report = buildReport(
      'e1',
      [attempt({ correctCount: 0, answered: 0, timedCount: 0, timedMs: 0 })],
      [],
    );
    expect(report.attempts[0]!.avgTimePerAnswerMs).toBeNull();
    expect(report.summary).toMatchObject({
      avgTimePerAnswerMs: null,
      timeSource: null,
      outcomes: { total: 4, correct: 0, wrong: 0, unanswered: 4 },
    });
  });

  it('breaks down by domain, sorted by name with the unassigned group last', () => {
    const report = buildReport(
      'e1',
      [attempt({})],
      [
        domain({ domainId: null, name: null, timedCount: 0, timedMs: 0 }),
        domain({ domainId: 'd-process', name: 'Process', correct: 1 }),
        domain({ domainId: 'd-people', name: 'People', correct: 3 }),
      ],
    );
    expect(report.domains).toEqual([
      {
        domainId: 'd-people',
        name: 'People',
        total: 4,
        correct: 3,
        wrong: 0,
        unanswered: 1,
        correctPercent: 75,
        avgTimePerAnswerMs: 10_000,
      },
      {
        domainId: 'd-process',
        name: 'Process',
        total: 4,
        correct: 1,
        wrong: 2,
        unanswered: 1,
        correctPercent: 25,
        avgTimePerAnswerMs: 10_000,
      },
      {
        domainId: null,
        name: null,
        total: 4,
        correct: 2,
        wrong: 1,
        unanswered: 1,
        correctPercent: 50,
        avgTimePerAnswerMs: null,
      },
    ]);
  });
});
