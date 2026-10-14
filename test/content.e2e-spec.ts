import {
  createTestContext,
  resetDatabase,
  Role,
  type SignedIn,
  signInAs,
  singleChoice,
  type TestContext,
} from './helpers.js';

describe('Host content: topics, questions, exams (e2e)', () => {
  let ctx: TestContext;
  let hostA: SignedIn;
  let hostB: SignedIn;
  let user: SignedIn;
  let topicId: string;
  let otherTopicId: string;
  let people: string;
  let processDomain: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await resetDatabase(ctx.prisma);
    hostA = await signInAs(ctx, Role.HOST, 'host-a');
    hostB = await signInAs(ctx, Role.HOST, 'host-b');
    user = await signInAs(ctx, Role.USER);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('topics and domains', () => {
    it('hosts create shared topics; names are unique regardless of case and accents', async () => {
      const res = await ctx.api
        .post('/topics', hostA.token)
        .send({ name: 'PMP', description: 'Project Management Professional' })
        .expect(201);
      topicId = res.body.id;
      expect(res.body.slug).toBe('pmp');

      const dup = await ctx.api
        .post('/topics', hostB.token)
        .send({ name: ' pmp ' })
        .expect(409);
      expect(dup.body.code).toBe('TOPIC_EXISTS');

      const vi = await ctx.api
        .post('/topics', hostB.token)
        .send({ name: 'Quản lý dự án' })
        .expect(201);
      expect(vi.body.slug).toBe('quan-ly-du-an');
      otherTopicId = vi.body.id;
    });

    it('users can read topics but not create them; only the creator edits', async () => {
      await ctx.api
        .post('/topics', user.token)
        .send({ name: 'Nope' })
        .expect(403);
      const list = await ctx.api.get('/topics', user.token).expect(200);
      expect(list.body.map((t: { name: string }) => t.name)).toEqual(
        expect.arrayContaining(['PMP', 'Quản lý dự án']),
      );
      await ctx.api
        .patch(`/topics/${topicId}`, hostB.token)
        .send({ description: 'x' })
        .expect(403);
    });

    it('creates domains, rejecting duplicates in the same topic', async () => {
      const a = await ctx.api
        .post(`/topics/${topicId}/domains`, hostA.token)
        .send({ name: 'People' })
        .expect(201);
      const b = await ctx.api
        .post(`/topics/${topicId}/domains`, hostA.token)
        .send({ name: 'Process' })
        .expect(201);
      people = a.body.id;
      processDomain = b.body.id;
      expect(b.body.order).toBe(1);

      const dup = await ctx.api
        .post(`/topics/${topicId}/domains`, hostB.token)
        .send({ name: 'people' })
        .expect(409);
      expect(dup.body.code).toBe('DOMAIN_EXISTS');

      const topic = await ctx.api
        .get(`/topics/${topicId}`, user.token)
        .expect(200);
      expect(topic.body.domains.map((d: { name: string }) => d.name)).toEqual([
        'People',
        'Process',
      ]);
    });
  });

  describe('questions', () => {
    it('USER cannot use the question bank', async () => {
      await ctx.api.get('/questions', user.token).expect(403);
      await ctx.api
        .post('/questions', user.token)
        .send(singleChoice(topicId, 'Q'))
        .expect(403);
    });

    it('creates a single-choice question with generated option ids', async () => {
      const res = await ctx.api
        .post('/questions', hostA.token)
        .send(
          singleChoice(topicId, 'First question', {
            domainId: people,
            difficulty: 'EASY',
          }),
        )
        .expect(201);
      expect(res.body).toMatchObject({
        type: 'SINGLE_CHOICE',
        difficulty: 'EASY',
        version: 1,
        domain: { id: people, name: 'People' },
      });
      expect(res.body.definition.options).toHaveLength(4);
      for (const option of res.body.definition.options) {
        expect(typeof option.id).toBe('string');
      }
    });

    it.each([
      [
        'a single option',
        { options: [{ content: 'Only', isCorrect: true }] },
        'INVALID_QUESTION_DEFINITION',
      ],
      [
        'two correct options',
        {
          options: [
            { content: 'A', isCorrect: true },
            { content: 'B', isCorrect: true },
          ],
        },
        'INVALID_QUESTION_DEFINITION',
      ],
    ])('rejects %s', async (_label, definition, code) => {
      const res = await ctx.api
        .post('/questions', hostA.token)
        .send({ topicId, content: 'Bad', definition })
        .expect(400);
      expect(res.body.code).toBe(code);
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message).toMatch(/^definition\.options/);
    });

    it('rejects unsupported types and a domain from another topic', async () => {
      const type = await ctx.api
        .post('/questions', hostA.token)
        .send(singleChoice(topicId, 'Drag', { type: 'DRAG_DROP' }))
        .expect(400);
      expect(type.body.code).toBe('QUESTION_TYPE_NOT_SUPPORTED');

      const domain = await ctx.api
        .post('/questions', hostA.token)
        .send(singleChoice(otherTopicId, 'Wrong domain', { domainId: people }))
        .expect(400);
      expect(domain.body.code).toBe('DOMAIN_TOPIC_MISMATCH');
    });

    it('keeps question banks private between hosts', async () => {
      const own = await ctx.api
        .post('/questions', hostB.token)
        .send(singleChoice(topicId, 'Host B question'))
        .expect(201);
      await ctx.api.get(`/questions/${own.body.id}`, hostA.token).expect(404);
      await ctx.api
        .patch(`/questions/${own.body.id}`, hostA.token)
        .send({ content: 'x' })
        .expect(404);

      const listA = await ctx.api.get('/questions', hostA.token).expect(200);
      expect(
        listA.body.items.every(
          (q: { ownerId: string }) => q.ownerId === hostA.id,
        ),
      ).toBe(true);
    });

    it('filters the bank and bumps the version on edit', async () => {
      await ctx.api
        .post('/questions', hostA.token)
        .send(
          singleChoice(topicId, 'Process question', {
            domainId: processDomain,
            difficulty: 'HARD',
          }),
        )
        .expect(201);

      const hard = await ctx.api
        .get(`/questions?topicId=${topicId}&difficulty=HARD`, hostA.token)
        .expect(200);
      expect(hard.body.total).toBe(1);
      const question = hard.body.items[0];

      const keptId = question.definition.options[0].id;
      const updated = await ctx.api
        .patch(`/questions/${question.id}`, hostA.token)
        .send({
          content: 'Process question (edited)',
          definition: {
            options: [
              { id: keptId, content: 'Kept option', isCorrect: true },
              { content: 'New option', isCorrect: false },
            ],
          },
        })
        .expect(200);
      expect(updated.body.version).toBe(2);
      expect(updated.body.definition.options[0].id).toBe(keptId);

      const search = await ctx.api
        .get('/questions?q=EDITED', hostA.token)
        .expect(200);
      expect(search.body.total).toBe(1);
    });
  });

  describe('exams', () => {
    let examId: string;
    let sections: { id: string; title: string }[];
    let questionIds: string[];

    beforeAll(async () => {
      questionIds = [];
      for (const [index, domainId] of [
        people,
        people,
        processDomain,
      ].entries()) {
        const res = await ctx.api
          .post('/questions', hostA.token)
          .send(singleChoice(topicId, `Exam question ${index}`, { domainId }))
          .expect(201);
        questionIds.push(res.body.id);
      }
    });

    it('creates an exam with one default section when no sections are given', async () => {
      const res = await ctx.api
        .post('/exams', hostA.token)
        .send({ topicId, title: 'No sections' })
        .expect(201);
      expect(res.body.sections).toHaveLength(1);
      expect(res.body.status).toBe('DRAFT');

      const last = await ctx.api
        .delete(
          `/exams/${res.body.id}/sections/${res.body.sections[0].id}`,
          hostA.token,
        )
        .expect(409);
      expect(last.body.code).toBe('LAST_SECTION');
    });

    it('creates an exam with sections', async () => {
      const res = await ctx.api
        .post('/exams', hostA.token)
        .send({
          topicId,
          title: 'PMP Mock',
          durationMinutes: 60,
          passingScore: 70,
          sections: [{ title: 'Section 1' }, { title: 'Section 2' }],
        })
        .expect(201);
      examId = res.body.id;
      sections = res.body.sections;
      expect(sections.map((s) => s.title)).toEqual(['Section 1', 'Section 2']);
    });

    it('adds questions from the owner bank only, once per exam', async () => {
      const added = await ctx.api
        .post(
          `/exams/${examId}/sections/${sections[0].id}/questions`,
          hostA.token,
        )
        .send({ questionIds: questionIds.slice(0, 2), points: 2 })
        .expect(201);
      expect(added.body.questionCount).toBe(2);
      expect(added.body.totalPoints).toBe(4);

      const dup = await ctx.api
        .post(
          `/exams/${examId}/sections/${sections[1].id}/questions`,
          hostA.token,
        )
        .send({ questionIds: [questionIds[0]] })
        .expect(409);
      expect(dup.body.code).toBe('QUESTION_ALREADY_IN_EXAM');

      const foreign = await ctx.api.get('/questions', hostB.token).expect(200);
      const notMine = await ctx.api
        .post(
          `/exams/${examId}/sections/${sections[1].id}/questions`,
          hostA.token,
        )
        .send({ questionIds: [foreign.body.items[0].id] })
        .expect(400);
      expect(notMine.body.code).toBe('QUESTIONS_NOT_FOUND');

      const otherTopic = await ctx.api
        .post('/questions', hostA.token)
        .send(singleChoice(otherTopicId, 'Other topic question'))
        .expect(201);
      const mismatch = await ctx.api
        .post(
          `/exams/${examId}/sections/${sections[1].id}/questions`,
          hostA.token,
        )
        .send({ questionIds: [otherTopic.body.id] })
        .expect(400);
      expect(mismatch.body.code).toBe('QUESTION_TOPIC_MISMATCH');
    });

    it('refuses to publish while a section is empty', async () => {
      const res = await ctx.api
        .post(`/exams/${examId}/publish`, hostA.token)
        .expect(409);
      expect(res.body.code).toBe('EXAM_NOT_PUBLISHABLE');
      expect(res.body.message).toContain('Section 2');
    });

    it('moves, reorders and publishes', async () => {
      await ctx.api
        .post(
          `/exams/${examId}/sections/${sections[1].id}/questions`,
          hostA.token,
        )
        .send({ questionIds: [questionIds[2]] })
        .expect(201);
      const moved = await ctx.api
        .patch(`/exams/${examId}/questions/${questionIds[1]}`, hostA.token)
        .send({ sectionId: sections[1].id, points: 1 })
        .expect(200);
      expect(
        moved.body.sections[1].questions.map(
          (q: { questionId: string }) => q.questionId,
        ),
      ).toEqual([questionIds[2], questionIds[1]]);

      const reordered = await ctx.api
        .put(
          `/exams/${examId}/sections/${sections[1].id}/questions/order`,
          hostA.token,
        )
        .send({ questionIds: [questionIds[1], questionIds[2]] })
        .expect(200);
      expect(reordered.body.sections[1].questions[0].questionId).toBe(
        questionIds[1],
      );

      const sectionOrder = await ctx.api
        .put(`/exams/${examId}/sections/order`, hostA.token)
        .send({ sectionIds: [sections[1].id, sections[0].id] })
        .expect(200);
      expect(sectionOrder.body.sections[0].id).toBe(sections[1].id);

      const published = await ctx.api
        .post(`/exams/${examId}/publish`, hostA.token)
        .expect(200);
      expect(published.body.status).toBe('PUBLISHED');
    });

    it('locks published exams and protects used questions', async () => {
      const edit = await ctx.api
        .patch(`/exams/${examId}`, hostA.token)
        .send({ title: 'x' })
        .expect(409);
      expect(edit.body.code).toBe('EXAM_NOT_EDITABLE');
      await ctx.api
        .post(`/exams/${examId}/sections`, hostA.token)
        .send({ title: 'Section 3' })
        .expect(409);

      const remove = await ctx.api
        .delete(`/questions/${questionIds[0]}`, hostA.token)
        .expect(409);
      expect(remove.body.code).toBe('QUESTION_IN_USE');

      const inUse = await ctx.api
        .delete(`/topics/${topicId}`, hostA.token)
        .expect(409);
      expect(inUse.body.code).toBe('TOPIC_IN_USE');
    });

    it('hides exams from other hosts', async () => {
      await ctx.api.get(`/exams/${examId}`, hostB.token).expect(404);
      await ctx.api.post(`/exams/${examId}/unpublish`, hostB.token).expect(404);
      const list = await ctx.api.get('/exams', hostB.token).expect(200);
      expect(list.body.total).toBe(0);
    });

    it('unpublish makes it editable again; delete works without attempts', async () => {
      const draft = await ctx.api
        .post(`/exams/${examId}/unpublish`, hostA.token)
        .expect(200);
      expect(draft.body.status).toBe('DRAFT');
      await ctx.api
        .patch(`/exams/${examId}`, hostA.token)
        .send({ title: 'Renamed' })
        .expect(200);
      await ctx.api.delete(`/exams/${examId}`, hostA.token).expect(204);
      await ctx.api
        .delete(`/questions/${questionIds[0]}`, hostA.token)
        .expect(204);
    });
  });
});
