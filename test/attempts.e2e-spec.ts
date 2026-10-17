import { eq } from 'drizzle-orm';

import { attemptQuestions, attempts } from '../src/db/schema';
import { MAX_ANSWER_TIME_MS } from '../src/modules/attempts/service';
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

describe('Catalog & test taking (e2e)', () => {
  let ctx: TestContext;
  let host: SignedIn;
  let user: SignedIn;
  let otherUser: SignedIn;
  let topicId: string;
  let questions: HostQuestion[];
  let examId: string;
  let attemptId: string;
  /** attemptQuestionId by host question content. */
  let byContent: Map<string, { id: string; options: string[] }>;

  async function publishExam(
    title: string,
    sectionsSpec: {
      title: string;
      items: { q: HostQuestion; points: number }[];
    }[],
    extra: Record<string, unknown> = {},
  ) {
    const exam = await ctx.api
      .post('/exams', host.token)
      .send({
        topicId,
        title,
        sections: sectionsSpec.map(({ title: t }) => ({ title: t })),
        ...extra,
      })
      .expect(201);
    for (const [index, section] of sectionsSpec.entries()) {
      for (const { q, points } of section.items) {
        await ctx.api
          .post(
            `/exams/${exam.body.id}/sections/${exam.body.sections[index].id}/questions`,
            host.token,
          )
          .send({ questionIds: [q.id], points })
          .expect(201);
      }
    }
    await ctx.api
      .post(`/exams/${exam.body.id}/publish`, host.token)
      .expect(200);
    return exam.body.id as string;
  }

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
    const domain = await ctx.api
      .post(`/topics/${topicId}/domains`, host.token)
      .send({ name: 'People' })
      .expect(201);

    questions = [];
    const specs = [
      {
        content: 'Q1 easy people',
        difficulty: 'EASY',
        domainId: domain.body.id,
      },
      {
        content: 'Q2 hard people',
        difficulty: 'HARD',
        domainId: domain.body.id,
      },
      { content: 'Q3 medium', difficulty: 'MEDIUM' },
      { content: 'Q4 medium', difficulty: 'MEDIUM' },
    ];
    for (const spec of specs) {
      const { content, ...extra } = spec;
      const res = await ctx.api
        .post('/questions', host.token)
        .send(singleChoice(topicId, content, extra))
        .expect(201);
      questions.push(res.body);
    }

    examId = await publishExam(
      'PMP Mock',
      [
        {
          title: 'Section 1',
          items: [
            { q: questions[0], points: 1 },
            { q: questions[1], points: 2 },
          ],
        },
        {
          title: 'Section 2',
          items: [
            { q: questions[2], points: 1 },
            { q: questions[3], points: 1 },
          ],
        },
      ],
      { passingScore: 50, durationMinutes: 30 },
    );
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('lists published exams in the catalog without question content', async () => {
    await ctx.api
      .post('/exams', host.token)
      .send({ topicId, title: 'Draft only' })
      .expect(201);

    const list = await ctx.api
      .get(`/catalog/exams?topicId=${topicId}`, user.token)
      .expect(200);
    expect(list.body.items.map((e: { title: string }) => e.title)).toEqual([
      'PMP Mock',
    ]);
    expect(list.body.items[0]).toMatchObject({
      questionCount: 4,
      sectionCount: 2,
    });

    const detail = await ctx.api
      .get(`/catalog/exams/${examId}`, user.token)
      .expect(200);
    expect(detail.body).toMatchObject({
      totalPoints: 5,
      passingScore: 50,
      durationMinutes: 30,
      inProgressAttemptId: null,
      myAttemptCount: 0,
    });
    expect(
      detail.body.sections.map(
        (s: { questionCount: number }) => s.questionCount,
      ),
    ).toEqual([2, 2]);
    expect(JSON.stringify(detail.body)).not.toContain('Q1 easy people');
  });

  it('starts an attempt and resumes it on a second call', async () => {
    const first = await ctx.api
      .post(`/catalog/exams/${examId}/attempts`, user.token)
      .expect(201);
    expect(first.body).toMatchObject({
      resumed: false,
      status: 'IN_PROGRESS',
      totalQuestions: 4,
      maxScore: 5,
      answeredCount: 0,
    });
    expect(new Date(first.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 29 * 60_000,
    );
    attemptId = first.body.id;

    const again = await ctx.api
      .post(`/catalog/exams/${examId}/attempts`, user.token)
      .expect(201);
    expect(again.body).toMatchObject({ resumed: true, id: attemptId });

    const detail = await ctx.api
      .get(`/catalog/exams/${examId}`, user.token)
      .expect(200);
    expect(detail.body.inProgressAttemptId).toBe(attemptId);
  });

  it('never leaks answers while the attempt is in progress', async () => {
    const res = await ctx.api
      .get(`/attempts/${attemptId}`, user.token)
      .expect(200);
    const json = JSON.stringify(res.body);
    for (const secret of [
      'isCorrect',
      'answerKey',
      'explanation',
      'correctOptionId',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(res.body.sections.map((s: { title: string }) => s.title)).toEqual([
      'Section 1',
      'Section 2',
    ]);
    expect(res.body.questions[0]).toMatchObject({
      order: 1,
      type: 'SINGLE_CHOICE',
      points: 1,
    });
    expect(res.body.serverTime).toBeDefined();

    byContent = new Map(
      res.body.questions.map(
        (q: {
          id: string;
          content: string;
          data: { options: { id: string }[] };
        }) => [
          q.content,
          { id: q.id, options: q.data.options.map((o) => o.id) },
        ],
      ),
    );

    await ctx.api.get(`/attempts/${attemptId}/result`, user.token).expect(409);
    await ctx.api.get(`/attempts/${attemptId}/review`, user.token).expect(409);
  });

  it('keeps attempts private', async () => {
    await ctx.api.get(`/attempts/${attemptId}`, otherUser.token).expect(404);
    await ctx.api
      .patch(`/attempts/${attemptId}/answers`, otherUser.token)
      .send({
        answers: [
          {
            attemptQuestionId: byContent.get('Q1 easy people')!.id,
            flagged: true,
          },
        ],
      })
      .expect(404);
  });

  it('validates answers', async () => {
    const q1 = byContent.get('Q1 easy people')!;
    const bad = await ctx.api
      .patch(`/attempts/${attemptId}/answers`, user.token)
      .send({
        answers: [{ attemptQuestionId: q1.id, response: { optionId: 'nope' } }],
      })
      .expect(400);
    expect(bad.body.code).toBe('INVALID_RESPONSE');

    const foreign = await ctx.api
      .patch(`/attempts/${attemptId}/answers`, user.token)
      .send({
        answers: [
          {
            attemptQuestionId: '0199e3a4-5b6c-7d8e-9f01-23456789abcd',
            flagged: true,
          },
        ],
      })
      .expect(400);
    expect(foreign.body.code).toBe('INVALID_ATTEMPT_QUESTION');
  });

  it('saves a batch of answers and flags', async () => {
    const [q1, q2, q3, q4] = questions;
    const answer = (q: HostQuestion, pick: 'correct' | 'wrong') => ({
      attemptQuestionId: byContent.get(q.content)!.id,
      response: { optionId: optionIds(q)[pick] },
    });

    const res = await ctx.api
      .patch(`/attempts/${attemptId}/answers`, user.token)
      .send({
        answers: [
          answer(q1, 'correct'),
          answer(q2, 'wrong'),
          answer(q3, 'wrong'),
          { attemptQuestionId: byContent.get(q4.content)!.id, flagged: true },
        ],
      })
      .expect(200);
    expect(res.body).toMatchObject({
      saved: 4,
      answeredCount: 3,
      flaggedCount: 1,
    });

    // Change one answer and clear another.
    const changed = await ctx.api
      .patch(`/attempts/${attemptId}/answers`, user.token)
      .send({
        answers: [
          answer(q2, 'correct'),
          { attemptQuestionId: byContent.get(q3.content)!.id, response: null },
        ],
      })
      .expect(200);
    expect(changed.body.answeredCount).toBe(2);
  });

  it('adds up the time spent before each pick', async () => {
    const q1 = questions[0];
    const id = byContent.get(q1.content)!.id;
    const pick = (timeSpentMs: unknown) =>
      ctx.api.patch(`/attempts/${attemptId}/answers`, user.token).send({
        answers: [
          {
            attemptQuestionId: id,
            response: { optionId: optionIds(q1).correct },
            timeSpentMs,
          },
        ],
      });
    const stored = async () => {
      const [row] = await ctx.db
        .select({ timeSpentMs: attemptQuestions.timeSpentMs })
        .from(attemptQuestions)
        .where(eq(attemptQuestions.id, id));
      return row.timeSpentMs;
    };

    await pick(3000).expect(200);
    await pick(2000).expect(200);
    expect(await stored()).toBe(5000);

    // Only an answer pick carries time; a flag change does not.
    await ctx.api
      .patch(`/attempts/${attemptId}/answers`, user.token)
      .send({
        answers: [{ attemptQuestionId: id, flagged: false, timeSpentMs: 9000 }],
      })
      .expect(200);
    expect(await stored()).toBe(5000);

    for (const bad of [-1, 1.5, '100']) {
      const res = await pick(bad).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }

    // A long pause is clamped, not rejected.
    await pick(99_999_999).expect(200);
    expect(await stored()).toBe(5000 + MAX_ANSWER_TIME_MS);
  });

  it('is not affected by host edits made after the attempt started', async () => {
    const q1 = questions[0];
    await ctx.api.post(`/exams/${examId}/unpublish`, host.token).expect(200);
    await ctx.api
      .patch(`/questions/${q1.id}`, host.token)
      .send({ content: 'Q1 rewritten' })
      .expect(200);
    await ctx.api.post(`/exams/${examId}/publish`, host.token).expect(200);

    const res = await ctx.api
      .get(`/attempts/${attemptId}`, user.token)
      .expect(200);
    const contents = res.body.questions.map(
      (q: { content: string }) => q.content,
    );
    expect(contents).toContain('Q1 easy people');
    expect(contents).not.toContain('Q1 rewritten');
  });

  it('submits, grades with a breakdown and is idempotent', async () => {
    const res = await ctx.api
      .post(`/attempts/${attemptId}/submit`, user.token)
      .expect(200);
    // Q1 (1 pt) + Q2 (2 pts) correct, Q3 cleared, Q4 unanswered → 3 / 5 = 60% ≥ 50%.
    expect(res.body).toMatchObject({
      status: 'SUBMITTED',
      score: 3,
      maxScore: 5,
      percent: 60,
      correctCount: 2,
      answeredCount: 2,
      totalQuestions: 4,
      passed: true,
    });
    const { sections, domains, difficulties } = res.body.breakdown;
    expect(
      sections.map((s: { title: string; percent: number }) => [
        s.title,
        s.percent,
      ]),
    ).toEqual([
      ['Section 1', 100],
      ['Section 2', 0],
    ]);
    expect(
      domains.map((d: { name: string; correct: number; total: number }) => [
        d.name,
        d.correct,
        d.total,
      ]),
    ).toEqual([
      ['People', 2, 2],
      ['Unassigned', 0, 2],
    ]);
    expect(
      difficulties.map((d: { difficulty: string }) => d.difficulty),
    ).toEqual(['EASY', 'MEDIUM', 'HARD']);

    const again = await ctx.api
      .post(`/attempts/${attemptId}/submit`, user.token)
      .expect(200);
    expect(again.body.score).toBe(3);

    const late = await ctx.api
      .patch(`/attempts/${attemptId}/answers`, user.token)
      .send({
        answers: [
          { attemptQuestionId: byContent.get('Q4 medium')!.id, flagged: false },
        ],
      })
      .expect(409);
    expect(late.body.code).toBe('ATTEMPT_CLOSED');
  });

  it('reveals answers and explanations in the review', async () => {
    const res = await ctx.api
      .get(`/attempts/${attemptId}/review`, user.token)
      .expect(200);
    const q1 = res.body.questions.find(
      (q: { content: string }) => q.content === 'Q1 easy people',
    );
    expect(q1).toMatchObject({
      isCorrect: true,
      score: 1,
      difficulty: 'EASY',
      domain: { name: 'People' },
      explanation: expect.any(String),
      answerKey: { correctOptionId: optionIds(questions[0]).correct },
    });
    const q4 = res.body.questions.find(
      (q: { content: string }) => q.content === 'Q4 medium',
    );
    expect(q4).toMatchObject({
      isCorrect: false,
      score: 0,
      response: null,
      flagged: true,
    });
  });

  it('expires an attempt whose time ran out and grades what was saved', async () => {
    const timed = await publishExam(
      'Timed',
      [
        {
          title: 'Only',
          items: [
            { q: questions[2], points: 1 },
            { q: questions[3], points: 1 },
          ],
        },
      ],
      { durationMinutes: 1 },
    );
    const start = await ctx.api
      .post(`/catalog/exams/${timed}/attempts`, user.token)
      .expect(201);
    const first = start.body.questions[0];
    await ctx.api
      .patch(`/attempts/${start.body.id}/answers`, user.token)
      .send({
        answers: [
          {
            attemptQuestionId: first.id,
            response: { optionId: first.data.options[0].id },
          },
        ],
      })
      .expect(200);

    // Jump past the deadline (+ grace).
    await ctx.db
      .update(attempts)
      .set({ expiresAt: new Date(Date.now() - 120_000) })
      .where(eq(attempts.id, start.body.id));

    const late = await ctx.api
      .patch(`/attempts/${start.body.id}/answers`, user.token)
      .send({ answers: [{ attemptQuestionId: first.id, flagged: true }] })
      .expect(409);
    expect(late.body.code).toBe('ATTEMPT_EXPIRED');

    const result = await ctx.api
      .get(`/attempts/${start.body.id}/result`, user.token)
      .expect(200);
    expect(result.body).toMatchObject({
      status: 'EXPIRED',
      answeredCount: 1,
      totalQuestions: 2,
      passed: null,
    });

    // A new attempt can be started afterwards.
    const next = await ctx.api
      .post(`/catalog/exams/${timed}/attempts`, user.token)
      .expect(201);
    expect(next.body.resumed).toBe(false);
  });

  it('lists the user attempt history', async () => {
    const res = await ctx.api.get('/attempts', user.token).expect(200);
    expect(res.body.total).toBe(3);
    const submitted = res.body.items.find(
      (a: { id: string }) => a.id === attemptId,
    );
    expect(submitted).toMatchObject({
      status: 'SUBMITTED',
      percent: 60,
      passed: true,
      examTitle: 'PMP Mock',
    });

    const mine = await ctx.api.get('/attempts', otherUser.token).expect(200);
    expect(mine.body.total).toBe(0);
  });

  it('host cannot delete an exam that has attempts', async () => {
    await ctx.api.post(`/exams/${examId}/unpublish`, host.token).expect(200);
    const res = await ctx.api
      .delete(`/exams/${examId}`, host.token)
      .expect(409);
    expect(res.body.code).toBe('EXAM_HAS_ATTEMPTS');
    await ctx.api.post(`/exams/${examId}/archive`, host.token).expect(200);
    await ctx.api.get(`/catalog/exams/${examId}`, user.token).expect(404);
  });

  it("handles exams larger than D1's 100-parameter limit in single requests", async () => {
    const big = await ctx.api
      .post('/topics', host.token)
      .send({ name: 'Large topic' })
      .expect(201);
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      const res = await ctx.api
        .post('/questions', host.token)
        .send(singleChoice(big.body.id, `Large Q${i}`))
        .expect(201);
      ids.push(res.body.id);
    }
    const exam = await ctx.api
      .post('/exams', host.token)
      .send({ topicId: big.body.id, title: 'Large exam' })
      .expect(201);
    const added = await ctx.api
      .post(
        `/exams/${exam.body.id}/sections/${exam.body.sections[0].id}/questions`,
        host.token,
      )
      .send({ questionIds: ids })
      .expect(201);
    expect(added.body.questionCount).toBe(120);
    await ctx.api
      .post(`/exams/${exam.body.id}/publish`, host.token)
      .expect(200);

    const attempt = await ctx.api
      .post(`/catalog/exams/${exam.body.id}/attempts`, user.token)
      .expect(201);
    expect(attempt.body.totalQuestions).toBe(120);
    const answers = attempt.body.questions.map(
      (q: { id: string; data: { options: { id: string }[] } }) => ({
        attemptQuestionId: q.id,
        response: { optionId: q.data.options[0].id },
        flagged: true,
      }),
    );
    const saved = await ctx.api
      .patch(`/attempts/${attempt.body.id}/answers`, user.token)
      .send({ answers })
      .expect(200);
    expect(saved.body).toMatchObject({
      saved: 120,
      answeredCount: 120,
      flaggedCount: 120,
    });

    const result = await ctx.api
      .post(`/attempts/${attempt.body.id}/submit`, user.token)
      .expect(200);
    // Options are not shuffled, so option 0 (the correct one) was picked everywhere.
    expect(result.body).toMatchObject({
      score: 120,
      maxScore: 120,
      correctCount: 120,
    });
  });
});
