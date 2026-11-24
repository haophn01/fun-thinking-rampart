import type { ColorToken } from './tokens';

/** A text colour drawn on a background colour, both look tokens. */
export interface TextPair {
  fg: ColorToken;
  bg: ColorToken;
}

/** WCAG 2.x AA minimum for body-size text. */
export const BODY_TEXT_MIN = 4.5;
/** WCAG 2.x AA minimum for large text: 24 px+, or 18.7 px+ bold. */
export const LARGE_TEXT_MIN = 3;

/** Pairs allowed at body sizes (Look contract, contrast rule). */
export const BODY_TEXT_PAIRS: readonly TextPair[] = [
  { fg: 'ink', bg: 'sheet' },
  { fg: 'graphite', bg: 'sheet' },
  { fg: 'blue', bg: 'sheet' },
  { fg: 'red', bg: 'sheet' },
  { fg: 'ink', bg: 'vellum' },
  { fg: 'graphite', bg: 'vellum' },
  { fg: 'blue', bg: 'vellum' },
  { fg: 'sheet', bg: 'red' },
  { fg: 'sheet', bg: 'blue' },
  { fg: 'sheet', bg: 'ink' },
];

/**
 * Pairs allowed only for large text. Red on Vellum is about 4.39:1, so red text on the page
 * background must be 24 px+ (or 18.7 px+ bold); at body sizes red text sits on Sheet.
 */
export const LARGE_TEXT_PAIRS: readonly TextPair[] = [{ fg: 'red', bg: 'vellum' }];

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#RRGGBB` colour. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new TypeError(`Expected a #RRGGBB colour, got ${JSON.stringify(hex)}`);
  const [r, g, b] = match.slice(1).map((part) => channel(parseInt(part, 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG contrast ratio between two `#RRGGBB` colours, from 1 to 21; order doesn't matter. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}
