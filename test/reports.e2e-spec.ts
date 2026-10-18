import { eq } from 'drizzle-orm';

import { attemptQuestions, attempts } from '../src/db/schema';
import {
  createTestContext,
  optionIds,
  resetDatabase,
  Role,
  type SignedIn,
  signInAs,
  singleChoice,
  type TestContext,
} from './helpers';

interface HostQuestion {
  id: string;
  content: string;
  definition: { options: { id: string; isCorrect: boolean }[] };
}

type Pick = [HostQuestion, 'correct' | 'wrong'];

describe('Reports (e2e)', () => {
  let ctx: TestContext;
  let host: SignedIn;
  let user: SignedIn;
  let otherUser: SignedIn;
  let topicId: string;
  /** People, People, Process, no domain. */
  let q: HostQuestion[];
  let examA: string;
  let examB: string;
  let examC: string;
  let attemptA1: string;
  let attemptB1: string;

  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000);

  /** Publishes a one-section exam, 1 point per question. */
  async function publishExam(
    title: string,
    items: HostQuestion[],
    extra: Record<string, unknown> = {},
  ) {
    const exam = await ctx.api
      .post('/exams', host.token)
      .send({ topicId, title, ...extra })
      .expect(201);
    await ctx.api
      .post(
        `/exams/${exam.body.id}/sections/${exam.body.sections[0].id}/questions`,
        host.token,
      )
      .send({ questionIds: items.map((item) => item.id) })
      .expect(201);
    await ctx.api
      .post(`/exams/${exam.body.id}/publish`, host.token)
      .expect(200);
    return exam.body.id as string;
  }

  /** Starts (or resumes) an attempt, picks one answer per request, then submits. */
  async function takeAttempt(
    examId: string,
    picks: Pick[],
    {
      timeSpentMs,
      submit = true,
    }: { timeSpentMs?: number; submit?: boolean } = {},
  ) {
    const start = await ctx.api
      .post(`/catalog/exams/${examId}/attempts`, user.token)
      .expect(201);
    const idByContent = new Map<string, string>(
      start.body.questions.map((item: { id: string; content: string }) => [
        item.content,
        item.id,
      ]),
    );
    for (const [question, pick] of picks) {
      await ctx.api
        .patch(`/attempts/${start.body.id}/answers`, user.token)
        .send({
          answers: [
            {
              attemptQuestionId: idByContent.get(question.content),
              response: { optionId: optionIds(question)[pick] },
              timeSpentMs,
            },
          ],
        })
        .expect(200);
    }
    if (submit) {
      await ctx.api
        .post(`/attempts/${start.body.id}/submit`, user.token)
        .expect(200);
    }
    return start.body.id as string;
  }

  const report = (examId: string, token = user.token) =>
    ctx.api.get(`/reports/exams/${examId}`, token);

  beforeAll(async () => {
    ctx = await createTestContext();
    await resetDatabase(ctx.db);
    host = await signInAs(ctx, Role.HOST);
    user = await signInAs(ctx, Role.USER);
    otherUser = await signInAs(ctx, Role.USER, 'other');

    const topic = await ctx.api
      .post('/topics', host.token)
      .send({ name: 'PMP' })
      .expect(201);
    topicId = topic.body.id;
    const domainId = async (name: string) =>
      (
        await ctx.api
          .post(`/topics/${topicId}/domains`, host.token)
          .send({ name })
          .expect(201)
      ).body.id as string;
    const people = await domainId('People');
    const processId = await domainId('Process');

    q = [];
    for (const [content, extra] of [
      ['R1 people', { domainId: people }],
      ['R2 people', { domainId: people }],
      ['R3 process', { domainId: processId }],
      ['R4 none', {}],
    ] as const) {
      const res = await ctx.api
        .post('/questions', host.token)
        .send(singleChoice(topicId, content, extra))
        .expect(201);
      q.push(res.body);
    }

    examA = await publishExam('Exam A', q, { durationMinutes: 30 });
    examB = await publishExam('Exam B', [q[0], q[2]]);
    examC = await publishExam('Exam C', [q[1]]);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('requires authentication', async () => {
    await ctx.api.get('/reports/exams').expect(401);
    await ctx.api.get(`/reports/exams/${examA}`).expect(401);
    await ctx.api.get(`/reports/compare?examIds=${examA},${examB}`).expect(401);
  });

  it('is empty until an attempt is finished', async () => {
    // In progress: not counted. takeAttempt resumes this same attempt later.
    await takeAttempt(examA, [], { submit: false });

    const list = await ctx.api.get('/reports/exams', user.token).expect(200);
    expect(list.body).toEqual({ items: [] });
    const missing = await report(examA).expect(404);
    expect(missing.body.code).toBe('NOT_FOUND');
    await ctx.api
      .get(`/reports/compare?examIds=${examA},${examB}`, user.token)
      .expect(404);
  });

  it('reports one exam over several attempts', async () => {
    // 1st: R1 ✓, R2 ✗, R3 unanswered, R4 ✓ → 2/4. 2nd: all ✓ → 4/4.
    attemptA1 = await takeAttempt(
      examA,
      [
        [q[0], 'correct'],
        [q[1], 'wrong'],
        [q[3], 'correct'],
      ],
      { timeSpentMs: 4000 },
    );
    // Keep the two attempts clearly ordered: 6 minutes, twenty minutes ago.
    await ctx.db
      .update(attempts)
      .set({ startedAt: minutesAgo(20), submittedAt: minutesAgo(14) })
      .where(eq(attempts.id, attemptA1));
    await takeAttempt(
      examA,
      q.map((question): Pick => [question, 'correct']),
      { timeSpentMs: 2000 },
    );

    const res = await report(examA).expect(200);
    expect(res.body.examTitle).toBe('Exam A');
    expect(res.body.summary).toEqual({
      attemptCount: 2,
      avgCorrectPercent: 75,
      latestCorrectPercent: 100,
      bestCorrectPercent: 100,
      // (3 × 4s + 4 × 2s) / 7 answers
      avgTimePerAnswerMs: 2857,
      timeSource: 'measured',
      outcomes: { total: 8, correct: 6, wrong: 1, unanswered: 1 },
    });
    expect(res.body.attempts).toHaveLength(2);
    expect(res.body.attempts[0]).toMatchObject({
      attemptId: attemptA1,
      status: 'SUBMITTED',
      correctPercent: 50,
      correctCount: 2,
      answeredCount: 3,
      totalQuestions: 4,
      durationSeconds: 360,
      avgTimePerAnswerMs: 4000,
      timeEstimated: false,
    });
    expect(res.body.attempts[1]).toMatchObject({
      correctPercent: 100,
      avgTimePerAnswerMs: 2000,
    });
    expect(res.body.domains).toEqual([
      {
        domainId: expect.any(String),
        name: 'People',
        total: 4,
        correct: 3,
        wrong: 1,
        unanswered: 0,
        correctPercent: 75,
        avgTimePerAnswerMs: 3000,
      },
      {
        domainId: expect.any(String),
        name: 'Process',
        total: 2,
        correct: 1,
        wrong: 0,
        unanswered: 1,
        correctPercent: 50,
        avgTimePerAnswerMs: 2000,
      },
      {
        domainId: null,
        name: null,
        total: 2,
        correct: 2,
        wrong: 0,
        unanswered: 0,
        correctPercent: 100,
        avgTimePerAnswerMs: 3000,
      },
    ]);
  });

  it('estimates time for attempts recorded before timing existed', async () => {
    await ctx.db
      .update(attemptQuestions)
      .set({ dwellMs: null })
      .where(eq(attemptQuestions.attemptId, attemptA1));

    const res = await report(examA).expect(200);
    // 6 minutes over 3 answers.
    expect(res.body.attempts[0]).toMatchObject({
      avgTimePerAnswerMs: 120_000,
      timeEstimated: true,
    });
    expect(res.body.summary).toMatchObject({
      avgTimePerAnswerMs: Math.round((360_000 + 8000) / 7),
      timeSource: 'mixed',
    });
    // Domain times use measured answers only.
    expect(res.body.domains[0]).toMatchObject({
      name: 'People',
      avgTimePerAnswerMs: 2000,
    });
  });

  it('closes an overdue attempt and measures it up to its deadline', async () => {
    attemptB1 = await takeAttempt(examB, [[q[0], 'correct']], {
      submit: false,
    });
    await ctx.db
      .update(attempts)
      .set({ startedAt: minutesAgo(7), expiresAt: minutesAgo(2) })
      .where(eq(attempts.id, attemptB1));

    const res = await report(examB).expect(200);
    expect(res.body.attempts).toEqual([
      expect.objectContaining({
        attemptId: attemptB1,
        status: 'EXPIRED',
        correctPercent: 50,
        durationSeconds: 300,
        avgTimePerAnswerMs: 300_000,
        timeEstimated: true,
      }),
    ]);
  });

  it('grades closed attempts that missed grading before counting them', async () => {
    const id = await takeAttempt(examB, [
      [q[0], 'wrong'],
      [q[2], 'wrong'],
    ]);
    await ctx.db
      .update(attempts)
      .set({ score: null, correctCount: null, passed: null })
      .where(eq(attempts.id, id));
    await ctx.db
      .update(attemptQuestions)
      .set({ isCorrect: null, score: null })
      .where(eq(attemptQuestions.attemptId, id));

    const res = await report(examB).expect(200);
    expect(
      res.body.attempts.map(
        (a: { correctPercent: number }) => a.correctPercent,
      ),
    ).toEqual([50, 0]);
    expect(res.body.summary.outcomes).toEqual({
      total: 4,
      correct: 1,
      wrong: 2,
      unanswered: 1,
    });
  });

  it('lists finished exams, most recent first', async () => {
    const res = await ctx.api.get('/reports/exams', user.token).expect(200);
    expect(res.body.items).toEqual([
      {
        examId: examB,
        examTitle: 'Exam B',
        attemptCount: 2,
        lastAttemptAt: expect.any(String),
        avgCorrectPercent: 25,
      },
      {
        examId: examA,
        examTitle: 'Exam A',
        attemptCount: 2,
        lastAttemptAt: expect.any(String),
        avgCorrectPercent: 75,
      },
    ]);
  });

  it('compares exams in the requested order', async () => {
    const res = await ctx.api
      .get(`/reports/compare?examIds=${examB},${examA}`, user.token)
      .expect(200);
    const single = await report(examB).expect(200);
    expect(res.body.exams.map((e: { examId: string }) => e.examId)).toEqual([
      examB,
      examA,
    ]);
    expect(res.body.exams[0]).toEqual(single.body);

    const withUnfinished = await ctx.api
      .get(`/reports/compare?examIds=${examA},${examC}`, user.token)
      .expect(404);
    expect(withUnfinished.body.details).toEqual({ examIds: [examC] });
  });

  it('validates the comparison list', async () => {
    const ids = Array.from(
      { length: 6 },
      (_, i) => `0199e3a4-5b6c-7d8e-9f01-23456789abc${i}`,
    );
    for (const query of [
      '',
      `?examIds=${examA}`,
      `?examIds=${ids.join(',')}`,
      `?examIds=${examA},${examA}`,
      `?examIds=${examA},nope`,
      `?examIds=${examA},${examB}&extra=1`,
    ]) {
      const res = await ctx.api
        .get(`/reports/compare${query}`, user.token)
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    await ctx.api.get('/reports/exams/nope', user.token).expect(400);
  });

  it("keeps each user's reports private", async () => {
    const list = await ctx.api
      .get('/reports/exams', otherUser.token)
      .expect(200);
    expect(list.body.items).toEqual([]);
    await report(examA, otherUser.token).expect(404);
    await ctx.api
      .get(`/reports/compare?examIds=${examA},${examB}`, otherUser.token)
      .expect(404);
  });
});
