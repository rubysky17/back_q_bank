import { uuidv7 } from '../src/lib/uuidv7';
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

interface ViewQuestion {
  id: string;
  content: string;
  sectionOrder: number;
  data: { options: { id: string }[] };
}

const HOUR = 60 * 60_000;

describe('Sectioned attempts: sync, abandon, fresh start (e2e)', () => {
  let ctx: TestContext;
  let host: SignedIn;
  let user: SignedIn;
  let otherUser: SignedIn;
  let questions: HostQuestion[];
  let examId: string;

  /** Events with consecutive seqs, as the app records them. */
  function events(
    from: number,
    specs: {
      type: string;
      sectionOrder?: number;
      attemptQuestionId?: string;
      payload?: Record<string, unknown>;
      activeMs?: number;
    }[],
  ) {
    return specs.map((spec, index) => ({
      id: uuidv7(),
      seq: from + index,
      sectionOrder: 1,
      activeMs: 0,
      clientAt: Date.now(),
      ...spec,
    }));
  }

  function trace(
    attemptQuestionId: string,
    optionId: string | null,
    extra: Record<string, unknown> = {},
  ) {
    return {
      attemptQuestionId,
      response: optionId ? { optionId } : null,
      firstResponse: optionId ? { optionId } : null,
      flagged: false,
      everFlagged: false,
      confidence: null,
      eliminatedOptionIds: [],
      dwellMs: 20_000,
      timeToFirstAnswerMs: optionId ? 15_000 : null,
      timeToFinalAnswerMs: optionId ? 15_000 : null,
      visitCount: 1,
      answerChangeCount: 0,
      eliminationCount: 0,
      ...extra,
    };
  }

  async function start(token: string, body?: Record<string, unknown>) {
    const req = ctx.api.post(`/catalog/exams/${examId}/attempts`, token);
    const res = await (body ? req.send(body) : req).expect(201);
    return res.body as {
      id: string;
      resumed: boolean;
      mode: string;
      questions: ViewQuestion[];
    };
  }

  const byContent = (view: { questions: ViewQuestion[] }, content: string) =>
    view.questions.find((q) => q.content === content)!;

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
    questions = [];
    for (const content of ['S1 Q1', 'S1 Q2', 'S2 Q1']) {
      const res = await ctx.api
        .post('/questions', host.token)
        .send(singleChoice(topic.body.id, content))
        .expect(201);
      questions.push(res.body);
    }

    const exam = await ctx.api
      .post('/exams', host.token)
      .send({
        topicId: topic.body.id,
        title: 'Sectioned mock',
        passingScore: 50,
        breakMinutes: 10,
        sections: [
          { title: 'Section 1', durationMinutes: 60 },
          { title: 'Section 2', durationMinutes: 60 },
        ],
      })
      .expect(201);
    examId = exam.body.id;
    const placements = [
      [0, [questions[0], questions[1]]],
      [1, [questions[2]]],
    ] as const;
    for (const [index, items] of placements) {
      await ctx.api
        .post(
          `/exams/${examId}/sections/${exam.body.sections[index].id}/questions`,
          host.token,
        )
        .send({ questionIds: items.map((q) => q.id) })
        .expect(201);
    }
    await ctx.api.post(`/exams/${examId}/publish`, host.token).expect(200);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('starts a SECTIONED attempt with one clock per section and no deadline', async () => {
    const detail = await ctx.api
      .get(`/catalog/exams/${examId}`, user.token)
      .expect(200);
    expect(detail.body.breakMinutes).toBe(10);
    expect(
      detail.body.sections.map(
        (s: { durationMinutes: number }) => s.durationMinutes,
      ),
    ).toEqual([60, 60]);

    const view = await start(user.token);
    expect(view).toMatchObject({
      resumed: false,
      mode: 'SECTIONED',
      phase: 'NOT_STARTED',
      currentSectionOrder: 1,
      breakMinutes: 10,
      expiresAt: null,
      syncedSeq: 0,
    });
    expect(
      (view as unknown as { sections: { clock: unknown }[] }).sections.map(
        (s) => s.clock,
      ),
    ).toEqual([
      expect.objectContaining({ budgetMs: HOUR, usedMs: 0, status: 'LOCKED' }),
      expect.objectContaining({ budgetMs: HOUR, usedMs: 0, status: 'LOCKED' }),
    ]);

    // The legacy per-answer endpoint is closed to sectioned attempts.
    const res1 = await ctx.api
      .patch(`/attempts/${view.id}/answers`, user.token)
      .send({
        answers: [{ attemptQuestionId: view.questions[0].id, flagged: true }],
      })
      .expect(409);
    expect(res1.body.code).toBe('ATTEMPT_SECTIONED');
  });

  it('syncs events and state idempotently, in seq order', async () => {
    const view = await start(user.token);
    expect(view.resumed).toBe(true);
    const q1 = byContent(view, 'S1 Q1');
    const { correct, wrong } = optionIds(questions[0]);

    const batch = events(1, [
      { type: 'SECTION_START' },
      { type: 'QUESTION_VIEW', attemptQuestionId: q1.id },
      {
        type: 'OPTION_ELIMINATE',
        attemptQuestionId: q1.id,
        payload: { optionId: wrong },
        activeMs: 5_000,
      },
      {
        type: 'ANSWER_SELECT',
        attemptQuestionId: q1.id,
        payload: { optionId: correct },
        activeMs: 15_000,
      },
      {
        type: 'CONFIDENCE_SET',
        attemptQuestionId: q1.id,
        payload: { level: 'HIGH' },
        activeMs: 16_000,
      },
    ]);
    const body = {
      lastSeq: 5,
      phase: 'IN_SECTION',
      currentSectionOrder: 1,
      events: batch,
      sections: [
        {
          sectionOrder: 1,
          usedMs: 20_000,
          status: 'ACTIVE',
          startedAt: Date.now(),
        },
      ],
      questions: [
        trace(q1.id, correct, {
          confidence: 'HIGH',
          eliminatedOptionIds: [wrong],
          eliminationCount: 1,
        }),
      ],
    };

    const first = await ctx.api
      .post(`/attempts/${view.id}/sync`, user.token)
      .send(body)
      .expect(200);
    expect(first.body).toMatchObject({ ackedSeq: 5, applied: true });

    // A retry after a lost response changes nothing.
    const retry = await ctx.api
      .post(`/attempts/${view.id}/sync`, user.token)
      .send(body)
      .expect(200);
    expect(retry.body).toMatchObject({ ackedSeq: 5, applied: true });
    const rows = await ctx.db.$client
      .prepare('SELECT count(*) AS n FROM "AttemptEvent" WHERE "attemptId" = ?')
      .bind(view.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(5);

    const state = await ctx.api
      .get(`/attempts/${view.id}`, user.token)
      .expect(200);
    expect(state.body).toMatchObject({ phase: 'IN_SECTION', syncedSeq: 5 });
    expect(
      state.body.questions.find((q: { id: string }) => q.id === q1.id),
    ).toMatchObject({
      response: { optionId: correct },
      confidence: 'HIGH',
      eliminatedOptionIds: [wrong],
      timeToFinalAnswerMs: 15_000,
      dwellMs: 20_000,
    });
  });

  it('acknowledges only the events without a gap and skips a state that does not match them', async () => {
    const view = await start(user.token);
    const q2 = byContent(view, 'S1 Q2');
    const { correct } = optionIds(questions[1]);
    const [six, , eight] = events(6, [
      { type: 'QUESTION_VIEW', attemptQuestionId: q2.id },
      { type: 'QUESTION_LEAVE', attemptQuestionId: q2.id },
      {
        type: 'ANSWER_SELECT',
        attemptQuestionId: q2.id,
        payload: { optionId: correct },
      },
    ]);

    const res = await ctx.api
      .post(`/attempts/${view.id}/sync`, user.token)
      .send({
        lastSeq: 8,
        phase: 'IN_SECTION',
        currentSectionOrder: 1,
        events: [six, eight],
        sections: [],
        questions: [trace(q2.id, correct)],
      })
      .expect(200);
    expect(res.body).toMatchObject({ ackedSeq: 6, applied: false });
    const state = await ctx.api
      .get(`/attempts/${view.id}`, user.token)
      .expect(200);
    expect(
      state.body.questions.find((q: { id: string }) => q.id === q2.id).response,
    ).toBeNull();
  });

  it('clamps clocks to the budget and never moves them back', async () => {
    const view = await start(user.token);
    await ctx.api
      .post(`/attempts/${view.id}/sync`, user.token)
      .send({
        lastSeq: 6,
        phase: 'IN_SECTION',
        currentSectionOrder: 1,
        events: [],
        sections: [
          { sectionOrder: 1, usedMs: 5 * HOUR, status: 'ACTIVE' },
          { sectionOrder: 2, usedMs: 0, status: 'LOCKED' },
        ],
        questions: [],
      })
      .expect(200);
    await ctx.api
      .post(`/attempts/${view.id}/sync`, user.token)
      .send({
        lastSeq: 6,
        phase: 'IN_SECTION',
        currentSectionOrder: 1,
        events: [],
        sections: [{ sectionOrder: 1, usedMs: 1_000, status: 'LOCKED' }],
        questions: [],
      })
      .expect(200);
    const state = await ctx.api
      .get(`/attempts/${view.id}`, user.token)
      .expect(200);
    expect(state.body.sections[0].clock).toMatchObject({
      usedMs: HOUR,
      status: 'ACTIVE',
    });

    const res2 = await ctx.api
      .post(`/attempts/${view.id}/sync`, user.token)
      .send({
        lastSeq: 6,
        phase: 'IN_SECTION',
        currentSectionOrder: 1,
        events: [],
        sections: [{ sectionOrder: 9, usedMs: 0, status: 'ACTIVE' }],
        questions: [],
      })
      .expect(400);
    expect(res2.body.code).toBe('INVALID_SECTION');
  });

  it('ignores answers to a section closed by an earlier upload', async () => {
    const view = await start(user.token);
    const q2 = byContent(view, 'S1 Q2');
    const { correct } = optionIds(questions[1]);
    const res3 = await ctx.api
      .post(`/attempts/${view.id}/sync`, user.token)
      .send({
        lastSeq: 9,
        phase: 'BREAK_OFFER',
        currentSectionOrder: 1,
        events: events(7, [
          { type: 'QUESTION_LEAVE', attemptQuestionId: q2.id },
          {
            type: 'ANSWER_SELECT',
            attemptQuestionId: q2.id,
            payload: { optionId: correct },
          },
          {
            type: 'SECTION_END',
            payload: { reason: 'TIME_UP' },
            activeMs: HOUR,
          },
        ]),
        sections: [
          {
            sectionOrder: 1,
            usedMs: HOUR,
            status: 'COMPLETED',
            endedAt: Date.now(),
            endReason: 'TIME_UP',
          },
        ],
        questions: [trace(q2.id, correct)],
      })
      .expect(200);
    expect(res3.body.ackedSeq).toBe(9);

    await ctx.api
      .post(`/attempts/${view.id}/sync`, user.token)
      .send({
        lastSeq: 10,
        phase: 'BREAK_OFFER',
        currentSectionOrder: 1,
        events: events(10, [
          { type: 'ANSWER_CLEAR', attemptQuestionId: q2.id },
        ]),
        sections: [],
        questions: [trace(q2.id, null)],
      })
      .expect(200);
    const state = await ctx.api
      .get(`/attempts/${view.id}`, user.token)
      .expect(200);
    expect(
      state.body.questions.find((q: { id: string }) => q.id === q2.id).response,
    ).toEqual({ optionId: correct });
    expect(state.body.sections[0].clock).toMatchObject({
      status: 'COMPLETED',
      endReason: 'TIME_UP',
    });
  });

  it('keeps attempts private', async () => {
    const view = await start(user.token);
    await ctx.api
      .post(`/attempts/${view.id}/sync`, otherUser.token)
      .send({
        lastSeq: 0,
        phase: 'IN_SECTION',
        currentSectionOrder: 1,
        events: [],
        sections: [],
        questions: [],
      })
      .expect(404);
    await ctx.api
      .post(`/attempts/${view.id}/abandon`, otherUser.token)
      .expect(404);
  });

  it('refuses to submit before the ATTEMPT_SUBMIT event is uploaded', async () => {
    const view = await start(user.token);
    const res4 = await ctx.api
      .post(`/attempts/${view.id}/submit`, user.token)
      .expect(409);
    expect(res4.body.code).toBe('ATTEMPT_NOT_SYNCED');
  });

  it('"fresh" abandons the attempt in progress, which keeps its answers and is graded without pass/fail', async () => {
    const old = await start(user.token);
    const fresh = await start(user.token, { fresh: true });
    expect(fresh.resumed).toBe(false);
    expect(fresh.id).not.toBe(old.id);

    // The abandoned attempt is graded on its first read.
    const result = await ctx.api
      .get(`/attempts/${old.id}/result`, user.token)
      .expect(200);
    expect(result.body).toMatchObject({
      status: 'ABANDONED',
      answeredCount: 2,
      correctCount: 2,
      passed: null,
      timeSpentSeconds: 3600,
    });
    expect(result.body.sectionTiming[0]).toMatchObject({
      endReason: 'TIME_UP',
    });

    const review = await ctx.api
      .get(`/attempts/${old.id}/review`, user.token)
      .expect(200);
    expect(
      review.body.questions.find(
        (q: { content: string }) => q.content === 'S1 Q1',
      ),
    ).toMatchObject({ confidence: 'HIGH', eliminationCount: 1 });

    const history = await ctx.api
      .get(`/attempts?examId=${examId}`, user.token)
      .expect(200);
    expect(
      history.body.items.map((a: { status: string; answeredCount: number }) => [
        a.status,
        a.answeredCount,
      ]),
    ).toEqual([
      ['IN_PROGRESS', 0],
      ['ABANDONED', 2],
    ]);

    // Uploads to the abandoned attempt are refused, so the app stops syncing it.
    const res5 = await ctx.api
      .post(`/attempts/${old.id}/sync`, user.token)
      .send({
        lastSeq: 10,
        phase: 'IN_SECTION',
        currentSectionOrder: 1,
        events: [],
        sections: [],
        questions: [],
      })
      .expect(409);
    expect(res5.body.code).toBe('ATTEMPT_CLOSED');
  });

  it('abandons explicitly, idempotently', async () => {
    const view = await start(user.token);
    const first = await ctx.api
      .post(`/attempts/${view.id}/abandon`, user.token)
      .expect(200);
    expect(first.body.status).toBe('ABANDONED');
    const again = await ctx.api
      .post(`/attempts/${view.id}/abandon`, user.token)
      .expect(200);
    expect(again.body.abandonedAt).toBe(first.body.abandonedAt);
  });

  it('submits once ATTEMPT_SUBMIT is synced', async () => {
    const view = await start(user.token);
    const s2 = byContent(view, 'S2 Q1');
    const { wrong } = optionIds(questions[2]);
    await ctx.api
      .post(`/attempts/${view.id}/sync`, user.token)
      .send({
        lastSeq: 3,
        phase: 'FINISHED',
        currentSectionOrder: 2,
        events: events(1, [
          { type: 'SECTION_START', sectionOrder: 2 },
          {
            type: 'ANSWER_SELECT',
            sectionOrder: 2,
            attemptQuestionId: s2.id,
            payload: { optionId: wrong },
          },
          { type: 'ATTEMPT_SUBMIT', sectionOrder: 2 },
        ]),
        sections: [],
        questions: [trace(s2.id, wrong)],
      })
      .expect(200);
    const result = await ctx.api
      .post(`/attempts/${view.id}/submit`, user.token)
      .expect(200);
    expect(result.body).toMatchObject({
      status: 'SUBMITTED',
      answeredCount: 1,
      correctCount: 0,
      passed: false,
    });
  });
});
