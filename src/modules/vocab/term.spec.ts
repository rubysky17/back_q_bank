// SAME TESTS in the apps (src/vocab/term.test.ts): keys must match on every side.
import {
  classifyKind,
  expandToWords,
  isValidTerm,
  MAX_CONTEXT_LENGTH,
  normalizeTerm,
  sentenceAround,
  termKey,
  tokenize,
} from './term';

describe('tokenize', () => {
  it('finds words with their offsets', () => {
    expect(tokenize('The project, again.')).toEqual([
      { start: 0, end: 3, norm: 'the' },
      { start: 4, end: 11, norm: 'project' },
      { start: 13, end: 18, norm: 'again' },
    ]);
  });

  it('keeps apostrophes and hyphens inside words', () => {
    expect(
      tokenize('don’t use state-of-the-art tools').map((t) => t.norm),
    ).toEqual(["don't", 'use', 'state-of-the-art', 'tools']);
  });

  it('reads Vietnamese letters as words', () => {
    expect(tokenize('bên liên quan').map((t) => t.norm)).toEqual([
      'bên',
      'liên',
      'quan',
    ]);
  });
});

describe('normalizeTerm', () => {
  it('trims punctuation and collapses spaces', () => {
    expect(normalizeTerm('  “Stakeholder   register,”  ')).toBe(
      'Stakeholder register',
    );
  });

  it('straightens apostrophes', () => {
    expect(normalizeTerm('project’s scope')).toBe("project's scope");
  });

  it('is empty without a word', () => {
    expect(normalizeTerm(' ... ')).toBe('');
  });
});

describe('termKey', () => {
  it('ignores case, spacing and punctuation between words', () => {
    expect(termKey('Cost,  Schedule')).toBe('cost schedule');
    expect(termKey('cost schedule')).toBe('cost schedule');
    expect(termKey('The PROJECT manager.')).toBe('the project manager');
  });

  it('treats curly and straight apostrophes alike', () => {
    expect(termKey('Don’t')).toBe(termKey("don't"));
  });

  it('is empty without a word', () => {
    expect(termKey('?!')).toBe('');
  });
});

describe('classifyKind', () => {
  it('tells words, phrases and sentences apart', () => {
    expect(classifyKind('stakeholder')).toBe('WORD');
    expect(classifyKind('state-of-the-art')).toBe('WORD');
    expect(classifyKind('critical path method')).toBe('PHRASE');
    expect(
      classifyKind('The project manager should escalate the issue now.'),
    ).toBe('SENTENCE');
    expect(classifyKind('Stop. Think again')).toBe('SENTENCE');
  });
});

describe('isValidTerm', () => {
  it('needs a letter and a reasonable length', () => {
    expect(isValidTerm('baseline')).toBe(true);
    expect(isValidTerm(' - ')).toBe(false);
    expect(isValidTerm('a'.repeat(201))).toBe(false);
  });
});

describe('expandToWords', () => {
  const text = 'Identify the stakeholder register.';

  it('grows a partial selection to whole words', () => {
    // "akeholder reg" → "stakeholder register"
    expect(expandToWords(text, 15, 28)).toEqual({ start: 13, end: 33 });
  });

  it('drops spaces around the selection', () => {
    expect(expandToWords(text, 12, 25)).toEqual({ start: 13, end: 24 });
  });

  it('is null when no word is selected', () => {
    expect(expandToWords(text, 33, 34)).toBeNull();
  });
});

describe('sentenceAround', () => {
  const text =
    'First sentence here. The sponsor approves the charter! Last one?';

  it('returns the sentence holding the term', () => {
    const start = text.indexOf('sponsor');
    expect(sentenceAround(text, start, start + 7)).toBe(
      'The sponsor approves the charter!',
    );
  });

  it('stops at line breaks', () => {
    const lines = 'Title line\nThe baseline changed';
    const start = lines.indexOf('baseline');
    expect(sentenceAround(lines, start, start + 8)).toBe(
      'The baseline changed',
    );
  });

  it('keeps long sentences short, around the term', () => {
    const long = `${'word '.repeat(100)}baseline ${'more '.repeat(100)}`;
    const start = long.indexOf('baseline');
    const context = sentenceAround(long, start, start + 8);
    expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT_LENGTH);
    expect(context).toContain('baseline');
  });
});
