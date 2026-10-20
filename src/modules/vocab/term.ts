/**
 * Vocabulary terms: normalising, keys, kinds and word tokens.
 *
 * SAME CODE in back_q_bank (src/modules/vocab/term.ts), client_q_bank and web_b_bank
 * (src/vocab/term.ts): the server recomputes `termKey` from what the apps send, so any difference
 * makes notes show up twice. Change all three together, with their tests.
 *
 * Character classes are spelled out (Latin, including Vietnamese) instead of `\p{L}`, which not
 * every JavaScript engine the apps run on supports.
 */

export type TermKind = 'WORD' | 'PHRASE' | 'SENTENCE';

/** Longest term that can be noted, after normalising. */
export const MAX_TERM_LENGTH = 200;
/** Longest context sentence kept with a note. */
export const MAX_CONTEXT_LENGTH = 300;

const LETTER = 'A-Za-z0-9\\u00C0-\\u024F\\u1E00-\\u1EFF';
/** A word: letters/digits, possibly joined by apostrophes or hyphens ("don't", "state-of-the-art"). */
const TOKEN_RE = new RegExp(`[${LETTER}]+(?:['’\\-][${LETTER}]+)*`, 'g');
const HAS_LETTER_RE = new RegExp(`[${LETTER}]`);
const EDGE_RE = new RegExp(`^[^${LETTER}]+|[^${LETTER}]+$`, 'g');
const SENTENCE_BREAK_RE = /[.!?]\s+\S/;

export interface Token {
  /** Offsets in the source text: `text.slice(start, end)` is the word as written. */
  start: number;
  end: number;
  /** Lowercase, straight apostrophes: what keys and matching compare. */
  norm: string;
}

/** Words of `text` with their offsets. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  for (let match = TOKEN_RE.exec(text); match; match = TOKEN_RE.exec(text)) {
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      norm: match[0].replace(/’/g, "'").toLowerCase(),
    });
  }
  return tokens;
}

/** How a term is shown: NFC, straight quotes, single spaces, no punctuation around it. */
export function normalizeTerm(raw: string): string {
  const composed =
    typeof raw.normalize === 'function' ? raw.normalize('NFC') : raw;
  return composed
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(EDGE_RE, '');
}

/**
 * Identity of a note: its words, lowercased, joined by single spaces ("Cost, Schedule" and
 * "cost schedule" are the same note). Empty when the term has no word.
 */
export function termKey(term: string): string {
  return tokenize(normalizeTerm(term))
    .map((token) => token.norm)
    .join(' ');
}

/** One word, a phrase, or a sentence (7+ words, or a sentence break inside). */
export function classifyKind(term: string): TermKind {
  const normalized = normalizeTerm(term);
  const words = tokenize(normalized).length;
  if (words <= 1) return 'WORD';
  if (words >= 7 || SENTENCE_BREAK_RE.test(normalized)) return 'SENTENCE';
  return 'PHRASE';
}

/** A term the apps may save: has a word and fits `MAX_TERM_LENGTH`. */
export function isValidTerm(term: string): boolean {
  const normalized = normalizeTerm(term);
  return (
    normalized.length > 0 &&
    normalized.length <= MAX_TERM_LENGTH &&
    HAS_LETTER_RE.test(normalized)
  );
}

/**
 * Grows `[start, end)` to whole words (a selection that cuts "stake|holder" takes "stakeholder").
 * Null when no word is inside.
 */
export function expandToWords(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const touched = tokenize(text).filter(
    (token) => token.end > start && token.start < end,
  );
  const first = touched[0];
  const last = touched[touched.length - 1];
  return first && last ? { start: first.start, end: last.end } : null;
}

/** The sentence around `[start, end)`, trimmed to `MAX_CONTEXT_LENGTH` around the term. */
export function sentenceAround(
  text: string,
  start: number,
  end: number,
): string {
  let from = start;
  while (from > 0 && !isSentenceEnd(text, from - 1)) from -= 1;
  let to = end;
  while (to < text.length && !isSentenceEnd(text, to)) to += 1;
  if (to < text.length) to += 1; // keep the final punctuation
  let sentence = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (sentence.length > MAX_CONTEXT_LENGTH) {
    const term = text.slice(start, end).replace(/\s+/g, ' ').trim();
    const at = Math.max(0, sentence.indexOf(term));
    const room = Math.max(0, MAX_CONTEXT_LENGTH - term.length);
    const begin = Math.max(0, at - Math.floor(room / 2));
    sentence = sentence.slice(begin, begin + MAX_CONTEXT_LENGTH).trim();
  }
  return sentence;
}

function isSentenceEnd(text: string, index: number): boolean {
  const char = text[index];
  if (char === '\n') return true;
  if (char !== '.' && char !== '!' && char !== '?') return false;
  const next = text[index + 1];
  return next === undefined || /\s/.test(next);
}
