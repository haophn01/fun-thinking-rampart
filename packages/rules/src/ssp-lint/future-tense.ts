/** Words that say a control isn't in place yet. Data: a change here is a test change too. */
export const FUTURE_TENSE_TERMS: readonly string[] = Object.freeze([
  'will',
  'plan to',
  'planned',
  'intend',
  'going to',
  'to be implemented',
  'TBD',
]);

function patternOf(term: string): RegExp {
  const words = term
    .split(' ')
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`\\b${words}\\b`, 'i');
}

const PATTERNS = FUTURE_TENSE_TERMS.map((term) => ({ term, pattern: patternOf(term) }));

/**
 * The future-tense terms in `text`, once each, in list order and spelled as in the list.
 * Case-insensitive on word boundaries (a hyphen is one); a space in a term matches any run of
 * whitespace, newlines and no-break spaces included. Blank or missing text matches nothing.
 */
export function findFutureTenseTerms(text: string | null | undefined): string[] {
  if (text === null || text === undefined) return [];
  return PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ term }) => term);
}
