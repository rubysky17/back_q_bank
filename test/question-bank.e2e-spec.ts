import { caseStudies } from '../src/db/schema';
import {
  createTestContext,
  resetDatabase,
  Role,
  type SignedIn,
  signInAs,
  singleChoice,
  type TestContext,
} from './helpers';

const chart = {
  url: '/media/pmp/test/chart.png',
  alt: 'Burndown chart',
  placement: 'CONTENT',
  width: 800,
  height: 400,
};
const solution = {
  ...chart,
  url: '/media/pmp/test/solution.png',
  placement: 'EXPLANATION',
};

describe('Question bank, case studies, media and new question types (e2e)', () => {
  let ctx: TestContext;
  let host: SignedIn;
  let user: SignedIn;
  let publishedId: string;
  let domainId: string;

  async function exam(title: string, questionIds: string[], publish: boolean) {
    const res = await ctx.api
      .post('/exams', host.token)
      .send({ topicId: topicIdOf, title, sections: [{ title: 'Section 1' }] })
      .expect(201);
    await ctx.api
      .post(
        `/exams/${res.body.id}/sections/${res.body.sections[0].id}/questions`,
        host.token,
      )
      .send({ questionIds })
      .expect(201);
    if (publish)
      await ctx.api
        .post(`/exams/${res.body.id}/publish`, host.token)
        .expect(200);
    return res.body.id as string;
  }
  let topicIdOf: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await resetDatabase(ctx.db);
    host = await signInAs(ctx, Role.HOST);
    user = await signInAs(ctx, Role.USER);

    topicIdOf = (
      await ctx.api
        .post('/topics', host.token)
        .send({ name: 'PMP' })
        .expect(201)
    ).body.id;
    domainId = (
      await ctx.api
        .post(`/topics/${topicIdOf}/domains`, host.token)
        .send({ name: 'Process' })
        .expect(201)
    ).body.id;
    const [caseStudy] = await ctx.db
      .insert(caseStudies)
      .values({
        topicId: topicIdOf,
        title: 'Case Study 1: Highway',
        content: 'Paragraph one.\n\nParagraph two.',
        createdById: host.id,
      })
      .returning({ id: caseStudies.id });

    const withCase = await ctx.api
      .post('/questions', host.token)
      .send(
        singleChoice(
          topicIdOf,
          'What should the PM do? (Refer to the case study)',
          {
            caseStudyId: caseStudy.id,
            domainId,
            difficulty: 'EXPERT',
            media: [chart, solution],
          },
        ),
      )
      .expect(201);
    expect(withCase.body.media).toHaveLength(2);

    const multi = await ctx.api
      .post('/questions', host.token)
      .send({
        topicId: topicIdOf,
        type: 'MULTIPLE_CHOICE',
        content: 'Which two actions? (Select two)',
        explanation: 'A and C',
        definition: {
          options: ['A', 'B', 'C', 'D'].map((letter) => ({
            content: `Action ${letter}`,
            isCorrect: letter === 'A' || letter === 'C',
          })),
        },
      })
      .expect(201);
    const hidden = await ctx.api
      .post('/questions', host.token)
      .send(singleChoice(topicIdOf, 'Only in a draft exam'))
      .expect(201);

    publishedId = await exam(
      'Full Test',
      [withCase.body.id, multi.body.id],
      true,
    );
    await exam('Draft', [hidden.body.id], false);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('requires a signed-in user', async () => {
    await ctx.api.get('/catalog/questions').expect(401);
  });

  it('rejects a case study from another topic and media outside /media', async () => {
    const other = await ctx.api
      .post('/topics', host.token)
      .send({ name: 'Other' })
      .expect(201);
    const [foreign] = await ctx.db
      .insert(caseStudies)
      .values({
        topicId: other.body.id,
        title: 'X',
        content: 'Y',
        createdById: host.id,
      })
      .returning({ id: caseStudies.id });
    const res = await ctx.api
      .post('/questions', host.token)
      .send(singleChoice(topicIdOf, 'Bad', { caseStudyId: foreign.id }))
      .expect(400);
    expect(res.body.code).toBe('CASE_STUDY_TOPIC_MISMATCH');
    await ctx.api
      .post('/questions', host.token)
      .send(
        singleChoice(topicIdOf, 'Bad media', {
          media: [{ ...chart, url: 'javascript:1' }],
        }),
      )
      .expect(400);
  });

  it('lists only questions of published exams, answers included, with filters', async () => {
    const all = await ctx.api.get('/catalog/questions', user.token).expect(200);
    expect(all.body.total).toBe(2);
    const [first] = all.body.items;
    expect(first.caseStudy).toEqual({
      title: 'Case Study 1: Highway',
      content: 'Paragraph one.\n\nParagraph two.',
    });
    expect(
      first.definition.options.some((o: { isCorrect: boolean }) => o.isCorrect),
    ).toBe(true);
    expect(first.explanation).toBeTruthy();

    const expert = await ctx.api
      .get(
        `/catalog/questions?difficulty=EXPERT&domainId=${domainId}`,
        user.token,
      )
      .expect(200);
    expect(expert.body.items.map((q: { type: string }) => q.type)).toEqual([
      'SINGLE_CHOICE',
    ]);

    const facets = await ctx.api
      .get('/catalog/questions/facets', user.token)
      .expect(200);
    expect(facets.body.exams).toHaveLength(1);
    expect(facets.body.exams[0].questionCount).toBe(2);
    expect(facets.body.domains).toEqual([
      { id: domainId, name: 'Process', questionCount: 1 },
    ]);
  });

  it('shows the domain/difficulty mix on the exam page', async () => {
    const res = await ctx.api
      .get(`/catalog/exams/${publishedId}`, user.token)
      .expect(200);
    expect(res.body.breakdown.difficulties).toEqual([
      { difficulty: 'MEDIUM', questionCount: 1 },
      { difficulty: 'EXPERT', questionCount: 1 },
    ]);
  });

  it('freezes case study and media into attempts and grades multiple choice', async () => {
    const start = await ctx.api
      .post(`/catalog/exams/${publishedId}/attempts`, user.token)
      .expect(201);
    const [single, multi] = start.body.questions;
    expect(single.caseStudy.title).toBe('Case Study 1: Highway');
    // Explanation images stay hidden until the review.
    expect(single.media).toEqual([chart]);
    expect(multi.data.selectCount).toBe(2);

    const pick = multi.data.options
      .filter(
        (o: { content: string }) =>
          o.content === 'Action A' || o.content === 'Action C',
      )
      .map((o: { id: string }) => o.id);
    await ctx.api
      .patch(`/attempts/${start.body.id}/answers`, user.token)
      .send({
        answers: [
          { attemptQuestionId: multi.id, response: { optionIds: pick } },
        ],
      })
      .expect(200);
    const result = await ctx.api
      .post(`/attempts/${start.body.id}/submit`, user.token)
      .expect(200);
    expect(result.body.correctCount).toBe(1);

    const review = await ctx.api
      .get(`/attempts/${start.body.id}/review`, user.token)
      .expect(200);
    expect(review.body.questions[0].media).toEqual([chart, solution]);
    expect(review.body.questions[1].isCorrect).toBe(true);
  });
});
