import { describe, expect, it } from 'vitest';
import {
  BODY_TEXT_MIN,
  BODY_TEXT_PAIRS,
  contrastRatio,
  LARGE_TEXT_MIN,
  LARGE_TEXT_PAIRS,
  type TextPair,
} from './contrast';
import { COLORS } from './tokens';

const key = (pair: TextPair) => `${pair.fg} on ${pair.bg}`;
const ratio = (pair: TextPair) => contrastRatio(COLORS[pair.fg], COLORS[pair.bg]);

describe('text pairs meet WCAG', () => {
  it('computes the WCAG 2 contrast ratio', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    // The two figures the plan's contrast rule quotes.
    expect(contrastRatio(COLORS.red, COLORS.sheet)).toBeCloseTo(4.97, 1);
    expect(contrastRatio(COLORS.red, COLORS.vellum)).toBeCloseTo(4.39, 1);
  });

  it('rejects anything but a six-digit hex colour', () => {
    expect(() => contrastRatio('red', '#FFFFFF')).toThrow(TypeError);
    expect(() => contrastRatio('#FFF', '#FFFFFF')).toThrow(TypeError);
  });

  it('lists exactly the contract body pairs, each at 4.5:1 or better', () => {
    expect(BODY_TEXT_MIN).toBe(4.5);
    expect(BODY_TEXT_PAIRS.map(key).sort()).toEqual(
      [
        'ink on sheet',
        'graphite on sheet',
        'blue on sheet',
        'red on sheet',
        'ink on vellum',
        'graphite on vellum',
        'blue on vellum',
        'sheet on red',
        'sheet on blue',
        'sheet on ink',
      ].sort(),
    );
    for (const pair of BODY_TEXT_PAIRS) {
      expect(ratio(pair), key(pair)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('lists the large-only pairs at 3:1 or better', () => {
    expect(LARGE_TEXT_MIN).toBe(3);
    expect(LARGE_TEXT_PAIRS.length).toBeGreaterThan(0);
    for (const pair of LARGE_TEXT_PAIRS) {
      expect(ratio(pair), key(pair)).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps red on Vellum below 4.5, out of the body list and in the large list', () => {
    const redOnVellum: TextPair = { fg: 'red', bg: 'vellum' };
    expect(ratio(redOnVellum)).toBeLessThan(4.5);
    expect(BODY_TEXT_PAIRS.map(key)).not.toContain(key(redOnVellum));
    expect(LARGE_TEXT_PAIRS.map(key)).toContain(key(redOnVellum));
  });
});
