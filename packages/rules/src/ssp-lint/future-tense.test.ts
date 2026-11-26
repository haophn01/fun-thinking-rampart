import { describe, expect, it } from 'vitest';
import { FUTURE_TENSE_TERMS, findFutureTenseTerms } from './future-tense';

describe('findFutureTenseTerms', () => {
  it('word boundaries', () => {
    // Case-insensitive, and punctuation or a hyphen is a boundary.
    expect(findFutureTenseTerms('WILL')).toEqual(['will']);
    expect(findFutureTenseTerms('Status: TBD.')).toEqual(['TBD']);
    expect(findFutureTenseTerms('tbd')).toEqual(['TBD']);
    expect(findFutureTenseTerms('Pure will-power.')).toEqual(['will']);
    expect(findFutureTenseTerms('(planned)')).toEqual(['planned']);

    // A space in a term matches any whitespace run: spaces, tabs, newlines, no-break spaces.
    expect(findFutureTenseTerms('We plan\u00a0\u00a0to encrypt.')).toEqual(['plan to']);
    expect(findFutureTenseTerms('We plan\n\tto encrypt.')).toEqual(['plan to']);
    expect(findFutureTenseTerms('MFA is going   to\r\nbe added')).toEqual(['going to']);
    expect(findFutureTenseTerms('Logging is to be\nimplemented.')).toEqual(['to be implemented']);
    expect(findFutureTenseTerms('We INTEND to.')).toEqual(['intend']);
    // No whitespace at all is not a match for a two-word term.
    expect(findFutureTenseTerms('planto')).toEqual([]);

    // Words that only contain a term don't match.
    for (const text of ['Willow', 'unplanned', 'skill', 'TBDs', 'intended', 'planning', 'Will_x']) {
      expect(findFutureTenseTerms(text), text).toEqual([]);
    }

    // Each matched term once, in list order, spelled as in the list.
    expect(findFutureTenseTerms('TBD. We will, we WILL, we plan to; it is planned. TBD')).toEqual([
      'will',
      'plan to',
      'planned',
      'TBD',
    ]);
    expect(findFutureTenseTerms(FUTURE_TENSE_TERMS.join(' / '))).toEqual([...FUTURE_TENSE_TERMS]);

    // Blank or missing text matches nothing.
    for (const text of [null, undefined, '', '   \n'])
      expect(findFutureTenseTerms(text)).toEqual([]);
    expect(findFutureTenseTerms('MFA is enforced for every user.')).toEqual([]);
  });
});
