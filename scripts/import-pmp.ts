/**
 * Imports the PMP full-length mock tests transcribed from screenshots (data/pmp) into D1.
 *
 *   npm run db:import:pmp            # validate, then import into the local D1
 *   npm run db:import:pmp:remote     # same against production
 *   npm run db:import:pmp -- --check # validate only
 *
 * Input, per paper N (1, 2) and section M (1-3):
 * - data/pmp/full-test-N/section-M.json: 60 questions + the case studies they use;
 * - data/pmp/domain-map.json: question numbers per domain (from Questions/info.md);
 * - public/media/pmp/ftN/sM/*.png: images cropped from the screenshots.
 *
 * Ids are derived from the source position ("ft1-s2-q17"), so re-running updates the same rows:
 * fixing a typo in the JSON and importing again bumps that question's `version` and nothing else.
 * Requires only the ADMIN account (`npm run db:admin`); the PMP topic and domains are created here.
 * The sample "PMP Mock Test 1" of `db:seed` is not involved.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { config } from 'dotenv';
import { z } from 'zod';

import type { Difficulty, QuestionMedia, QuestionType } from '../src/db/schema';
import { AppError } from '../src/lib/app-error';
import { searchKey } from '../src/lib/slugify';
import { uuidv7 } from '../src/lib/uuidv7';
import { getQuestionTypeHandler } from '../src/modules/questions/question-types';
import { topicSql } from './pmp-topic';

config({ quiet: true });

const remote = process.argv.includes('--remote');
const checkOnly = process.argv.includes('--check');

const PAPERS = [1, 2] as const;
const SECTIONS = [1, 2, 3] as const;
const QUESTIONS_PER_SECTION = 60;
/** Real PMP format: three timed sections of 60 minutes with an optional 10-minute break between them. */
const SECTION_MINUTES = 60;
const BREAK_MINUTES = 10;
const DURATION_MINUTES = 230;
const PASSING_SCORE = 70;
/** Fixed timestamp part of the derived ids, so they keep sorting in paper order. */
const ID_EPOCH = Date.UTC(2026, 9, 14);

const DIFFICULTY: Record<string, Difficulty> = {
  Easy: 'EASY',
  Moderate: 'MEDIUM',
  Medium: 'MEDIUM',
  Difficult: 'HARD',
  Hard: 'HARD',
  Expert: 'EXPERT',
  // A few hotspot / drag-and-drop screens show no difficulty level: they get the default.
  '': 'MEDIUM',
};

const TYPE_OF_KIND: Record<SourceQuestion['kind'], QuestionType> = {
  standard: 'SINGLE_CHOICE',
  hotspot: 'SINGLE_CHOICE',
  multi: 'MULTIPLE_CHOICE',
  match: 'DRAG_DROP',
};

const text = z.string().trim();
const sectionFileSchema = z.object({
  test: z.number(),
  section: z.number(),
  caseStudies: z.array(z.object({ title: text.min(1), content: text.min(1) })),
  questions: z.array(
    z.object({
      number: z.number().int().min(1).max(QUESTIONS_PER_SECTION),
      sourceFiles: z.array(z.string()),
      caseStudy: text.min(1).nullable(),
      stem: text.min(1),
      options: z
        .array(z.object({ key: text.regex(/^[A-Z]$/), text: text.min(1) }))
        .min(2)
        .max(10),
      /** One key, or a comma list for multi ("C,D") and match (choice key per target). */
      correct: text.regex(/^[A-Z](,[A-Z])*$/),
      solutionLine: text,
      explanation: text.min(1),
      difficulty: z.enum(Object.keys(DIFFICULTY) as [string, ...string[]]),
      kind: z.enum(['standard', 'hotspot', 'multi', 'match']),
      /** Drag and drop: `answer[i]` is the key of the choice that belongs in `targets[i]`. */
      match: z
        .object({
          targets: z.array(text.min(1)),
          choices: z.array(z.object({ key: text, text: text.min(1) })),
          answer: z.array(text),
        })
        .optional(),
      media: z.array(
        z.object({
          file: text.regex(/^[\w.-]+\.png$/),
          alt: text.min(1),
          placement: z.enum(['CONTENT', 'EXPLANATION']),
        }),
      ),
      notes: z.string().optional(),
    }),
  ),
});
const domainMapSchema = z.record(
  z.string(),
  z.record(z.string(), z.record(z.string(), z.array(z.number().int()))),
);

type SectionFile = z.infer<typeof sectionFileSchema>;
type SourceQuestion = SectionFile['questions'][number];

/** Deterministic UUIDv7-shaped id: fixed timestamp + 10 bytes of sha256(key). */
function stableId(key: string, sequence: number): string {
  const bytes = createHash('sha256').update(`pmp:${key}`).digest();
  let ms = ID_EPOCH + sequence;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms & 0xff;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** SQL literal (wrangler d1 execute --file takes no bound parameters). */
const lit = (value: string | number | null): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replaceAll("'", "''")}'`;
};

function pngSize(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(0, 24);
  if (header.toString('latin1', 1, 4) !== 'PNG') {
    throw new Error(`${path} is not a PNG`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

interface ImportQuestion {
  paper: number;
  section: number;
  number: number;
  domain: string;
  difficulty: Difficulty;
  caseStudyKey: string | null;
  content: string;
  explanation: string;
  media: QuestionMedia[];
  type: QuestionType;
  /** Validated by the type's handler, exactly as the API stores it. */
  definition: unknown;
}

interface ImportCaseStudy {
  key: string;
  paper: number;
  title: string;
  content: string;
}

/** Loads every section file and collects all problems instead of stopping at the first one. */
function load() {
  const problems: string[] = [];
  const domainMap = domainMapSchema.parse(
    JSON.parse(readFileSync('data/pmp/domain-map.json', 'utf8')),
  );
  const questions: ImportQuestion[] = [];
  const caseStudies = new Map<string, ImportCaseStudy>();

  for (const paper of PAPERS) {
    for (const section of SECTIONS) {
      const where = `full-test-${paper}/section-${section}`;
      const path = `data/pmp/${where}.json`;
      if (!existsSync(path)) {
        problems.push(`${where}: file missing`);
        continue;
      }
      const parsed = sectionFileSchema.safeParse(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      if (!parsed.success) {
        for (const issue of parsed.error.issues.slice(0, 10)) {
          problems.push(`${where}: ${issue.path.join('.')}: ${issue.message}`);
        }
        continue;
      }
      const file = parsed.data;

      const numbers = file.questions.map((q) => q.number).sort((a, b) => a - b);
      const expected = Array.from(
        { length: QUESTIONS_PER_SECTION },
        (_, i) => i + 1,
      );
      if (numbers.join() !== expected.join()) {
        problems.push(`${where}: question numbers are not exactly 1..60`);
      }

      for (const caseStudy of file.caseStudies) {
        const key = `ft${paper}:${caseStudy.title}`;
        const known = caseStudies.get(key);
        if (known && known.content !== caseStudy.content) {
          problems.push(
            `${where}: case study "${caseStudy.title}" differs from another section of the same paper`,
          );
        }
        if (!known) caseStudies.set(key, { key, paper, ...caseStudy });
      }

      const domainOf = new Map<number, string>();
      for (const [domain, list] of Object.entries(
        domainMap[`full-test-${paper}`]?.[`section-${section}`] ?? {},
      )) {
        for (const n of list) domainOf.set(n, domain);
      }

      for (const q of file.questions) {
        const label = `${where} Q${q.number}`;
        const domain = domainOf.get(q.number);
        if (!domain) problems.push(`${label}: no domain in domain-map.json`);
        if (q.notes?.includes('MISSING')) problems.push(`${label}: missing`);
        problems.push(...checkQuestion(label, q, file));

        const caseStudyKey = q.caseStudy ? `ft${paper}:${q.caseStudy}` : null;
        const media = q.media.flatMap((item) => {
          const relative = `media/pmp/ft${paper}/s${section}/${item.file}`;
          if (!existsSync(`public/${relative}`)) {
            problems.push(`${label}: image public/${relative} not found`);
            return [];
          }
          return [
            {
              url: `/${relative}`,
              alt: item.alt,
              placement: item.placement,
              ...pngSize(`public/${relative}`),
            },
          ];
        });
        const key = `ft${paper}-s${section}-q${String(q.number).padStart(2, '0')}`;
        questions.push({
          paper,
          section,
          number: q.number,
          domain: domain ?? '',
          difficulty: DIFFICULTY[q.difficulty],
          caseStudyKey,
          content: q.stem,
          explanation: q.explanation,
          media,
          type: TYPE_OF_KIND[q.kind],
          definition: definitionOf(label, key, q, problems),
        });
      }
    }
  }

  // Totals per domain must match info.md (e.g. paper 1: People 60, Process 73, Business Environment 47).
  for (const paper of PAPERS) {
    for (const [domain, expected] of Object.entries(
      domainTotals(domainMap, paper),
    )) {
      const actual = questions.filter(
        (q) => q.paper === paper && q.domain === domain,
      ).length;
      if (actual !== expected) {
        problems.push(
          `paper ${paper}: ${domain} has ${actual} questions, expected ${expected}`,
        );
      }
    }
  }
  return { questions, caseStudies: [...caseStudies.values()], problems };
}

/** Builds the API definition of a question and runs it through the type's handler. */
function definitionOf(
  label: string,
  key: string,
  q: SourceQuestion,
  problems: string[],
): unknown {
  const input =
    q.kind === 'match' && q.match
      ? {
          targets: q.match.targets.map((content, i) => ({
            id: `${key}-t${i + 1}`,
            content,
          })),
          choices: q.match.choices.map((choice) => ({
            id: `${key}-${choice.key}`,
            content: choice.text,
          })),
          answer: q.match.answer.map((choiceKey) =>
            q.match!.choices.findIndex((choice) => choice.key === choiceKey),
          ),
        }
      : {
          options: q.options.map((option) => ({
            id: `${key}-${option.key}`,
            content: option.text,
            isCorrect: q.correct.split(',').includes(option.key),
          })),
        };
  if (q.kind === 'match' && !q.match) {
    problems.push(`${label}: drag-and-drop question without "match"`);
    return null;
  }
  try {
    return getQuestionTypeHandler(TYPE_OF_KIND[q.kind]).parseDefinition(input);
  } catch (error) {
    problems.push(
      `${label}: ${error instanceof AppError ? error.message : String(error)}`,
    );
    return null;
  }
}

function domainTotals(
  domainMap: z.infer<typeof domainMapSchema>,
  paper: number,
) {
  const totals: Record<string, number> = {};
  for (const sections of Object.values(domainMap[`full-test-${paper}`] ?? {})) {
    for (const [domain, list] of Object.entries(sections)) {
      totals[domain] = (totals[domain] ?? 0) + list.length;
    }
  }
  return totals;
}

function checkQuestion(
  label: string,
  q: SourceQuestion,
  file: SectionFile,
): string[] {
  const problems: string[] = [];
  const keys = q.options.map((option) => option.key);
  if (new Set(keys).size !== keys.length)
    problems.push(`${label}: repeated option keys`);
  const contents = q.options.map((option) => option.text.toLowerCase());
  if (new Set(contents).size !== contents.length) {
    problems.push(`${label}: two options have the same text`);
  }
  if (q.options.some((option) => option.text.length > 2000)) {
    problems.push(`${label}: option longer than 2000 characters`);
  }
  const correctKeys = q.correct.split(',');
  const correct = q.options.find((option) => option.key === q.correct);
  if (correctKeys.some((k) => !keys.includes(k))) {
    problems.push(`${label}: correct answer ${q.correct} is not an option`);
  } else if (q.kind === 'multi') {
    // "Solution: C, D"
    const listed = q.solutionLine.replace(/\s/g, '').toUpperCase();
    if (listed && listed !== q.correct) {
      problems.push(
        `${label}: solution line "${q.solutionLine}" does not match ${q.correct}`,
      );
    }
  } else if (correct && q.kind !== 'match') {
    // The solution line repeats the answer: "C. Incorporate ..." (or the hotspot label, e.g. "Three").
    const line = q.solutionLine.toLowerCase();
    const agrees =
      line.startsWith(`${q.correct.toLowerCase()}.`) ||
      line.startsWith(`${q.correct.toLowerCase()} `) ||
      line === q.correct.toLowerCase() ||
      line.startsWith(correct.text.toLowerCase().slice(0, 20)) ||
      // Hotspot solutions describe the picked area ("Unknown-Unknown (Emergent risk): <box text>").
      (q.kind === 'hotspot' &&
        (line === '' ||
          line.includes(correct.text.toLowerCase().slice(0, 20))));
    if (!agrees) {
      problems.push(
        `${label}: solution line "${q.solutionLine.slice(0, 40)}" does not match answer ${q.correct}`,
      );
    }
  }
  if (q.caseStudy && !file.caseStudies.some((c) => c.title === q.caseStudy)) {
    problems.push(
      `${label}: case study "${q.caseStudy}" not defined in this file`,
    );
  }
  if (q.stem.length > 10_000 || q.explanation.length > 10_000) {
    problems.push(
      `${label}: stem or explanation longer than 10,000 characters`,
    );
  }
  return problems;
}

function buildSql(
  questions: ImportQuestion[],
  caseStudies: ImportCaseStudy[],
): string {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email)
    throw new Error(
      'ADMIN_EMAIL is required (the questions belong to the admin)',
    );
  const now = Date.now();
  const owner = `(SELECT "id" FROM "User" WHERE "email" = ${lit(email)})`;
  const topic = `(SELECT "id" FROM "Topic" WHERE "slug" = 'pmp')`;
  // The PMP topic and domains come along, so a fresh database needs only the admin account.
  const sql: string[] = topicSql(owner, now, uuidv7, lit);

  const caseStudyIds = new Map<string, string>();
  for (const [index, caseStudy] of caseStudies.entries()) {
    const id = stableId(`case:${caseStudy.key}`, index);
    caseStudyIds.set(caseStudy.key, id);
    sql.push(`INSERT INTO "CaseStudy" ("id", "topicId", "title", "content", "createdById", "createdAt", "updatedAt")
VALUES (${lit(id)}, ${topic}, ${lit(caseStudy.title)}, ${lit(caseStudy.content)}, ${owner}, ${now}, ${now})
ON CONFLICT ("id") DO UPDATE SET "title" = excluded."title", "content" = excluded."content", "updatedAt" = ${now}
WHERE "CaseStudy"."title" IS NOT excluded."title" OR "CaseStudy"."content" IS NOT excluded."content";`);
  }

  for (const paper of PAPERS) {
    const examId = stableId(`exam:${paper}`, paper * 1000);
    const title = `PMP Full Test ${paper}`;
    const total = questions.filter((q) => q.paper === paper).length;
    const description = `Full-length PMP mock exam: ${total} questions in 3 sections of 60, ${SECTION_MINUTES} minutes each with a ${BREAK_MINUTES}-minute break between sections. Every question comes with its explanation.`;
    sql.push(`INSERT INTO "Exam" ("id", "ownerId", "topicId", "title", "searchText", "description", "status", "durationMinutes", "breakMinutes", "passingScore", "shuffleQuestions", "shuffleOptions", "publishedAt", "createdAt", "updatedAt")
VALUES (${lit(examId)}, ${owner}, ${topic}, ${lit(title)}, ${lit(searchKey(title))}, ${lit(description)}, 'PUBLISHED', ${DURATION_MINUTES}, ${BREAK_MINUTES}, ${PASSING_SCORE}, 0, 0, ${now}, ${now}, ${now})
ON CONFLICT ("id") DO UPDATE SET "title" = excluded."title", "searchText" = excluded."searchText", "description" = excluded."description", "breakMinutes" = excluded."breakMinutes", "updatedAt" = ${now};`);

    for (const section of SECTIONS) {
      const sectionId = stableId(
        `section:${paper}:${section}`,
        paper * 1000 + section,
      );
      sql.push(`INSERT INTO "ExamSection" ("id", "examId", "title", "order", "durationMinutes", "createdAt", "updatedAt")
VALUES (${lit(sectionId)}, ${lit(examId)}, ${lit(`Section ${section}`)}, ${section}, ${SECTION_MINUTES}, ${now}, ${now})
ON CONFLICT ("id") DO UPDATE SET "durationMinutes" = excluded."durationMinutes", "updatedAt" = ${now}
WHERE "ExamSection"."durationMinutes" IS NOT excluded."durationMinutes";`);

      const items = questions
        .filter((q) => q.paper === paper && q.section === section)
        .sort((a, b) => a.number - b.number);
      for (const q of items) {
        const sequence = paper * 1000 + section * 100 + q.number;
        const key = `${paper}:${section}:${q.number}`;
        const questionId = stableId(`question:${key}`, sequence);
        const caseStudyId = q.caseStudyKey
          ? caseStudyIds.get(q.caseStudyKey)!
          : null;
        const columns = {
          domainId: `(SELECT "id" FROM "Domain" WHERE "topicId" = ${topic} AND "name" = ${lit(q.domain)})`,
          caseStudyId: lit(caseStudyId),
          difficulty: lit(q.difficulty),
          content: lit(q.content),
          searchText: lit(searchKey(q.content)),
          explanation: lit(q.explanation),
          media: lit(JSON.stringify(q.media)),
          type: lit(q.type),
          definition: lit(JSON.stringify(q.definition)),
        };
        // Only rows whose content changed get a new version.
        const changed = Object.keys(columns)
          .map((column) => `"Question"."${column}" IS NOT excluded."${column}"`)
          .join(' OR ');
        sql.push(`INSERT INTO "Question" ("id", "ownerId", "topicId", "version", "createdAt", "updatedAt", ${Object.keys(
          columns,
        )
          .map((c) => `"${c}"`)
          .join(', ')})
VALUES (${lit(questionId)}, ${owner}, ${topic}, 1, ${now}, ${now}, ${Object.values(columns).join(', ')})
ON CONFLICT ("id") DO UPDATE SET ${Object.keys(columns)
          .map((c) => `"${c}" = excluded."${c}"`)
          .join(
            ', ',
          )}, "version" = "Question"."version" + 1, "updatedAt" = ${now}
WHERE ${changed};`);
        sql.push(`INSERT INTO "ExamQuestion" ("id", "examId", "sectionId", "questionId", "order", "points", "sourceNumber", "createdAt")
VALUES (${lit(stableId(`placement:${key}`, sequence))}, ${lit(examId)}, ${lit(sectionId)}, ${lit(questionId)}, ${q.number}, 1, ${q.number}, ${now})
ON CONFLICT ("id") DO NOTHING;`);
      }
    }
  }
  return sql.join('\n\n') + '\n';
}

function wrangler(args: string[], capture = false): string {
  return execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'DB',
      remote ? '--remote' : '--local',
      ...args,
    ],
    {
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      encoding: 'utf8',
    },
  );
}

function assertPrerequisites() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? '';
  const out = wrangler(
    [
      '--json',
      '--command',
      `SELECT count(*) AS admins FROM "User" WHERE "email" = ${lit(email)} AND "role" = 'ADMIN'`,
    ],
    true,
  );
  const [{ results }] = JSON.parse(out) as {
    results: { admins: number }[];
  }[];
  if (results[0].admins !== 1) {
    throw new Error(
      `No ADMIN account ${email}: run \`npm run db:admin${remote ? ':remote' : ''}\` first (it does not add the sample exam)`,
    );
  }
}

const { questions, caseStudies, problems } = load();
if (problems.length > 0) {
  console.error(
    `${problems.length} problem(s) in data/pmp:\n- ${problems.join('\n- ')}`,
  );
  process.exit(1);
}
console.log(
  `data/pmp is valid: ${questions.length} questions, ${caseStudies.length} case studies, ${questions.reduce((n, q) => n + q.media.length, 0)} images`,
);
if (!checkOnly) {
  assertPrerequisites();
  mkdirSync('.wrangler', { recursive: true });
  const file = '.wrangler/import-pmp.sql';
  writeFileSync(file, buildSql(questions, caseStudies));
  wrangler(['--file', file, '--yes']);
  console.log(`imported into ${remote ? 'remote' : 'local'} D1`);
}
