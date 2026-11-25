/**
 * The look's source of truth (plan `## Look`, C · Inspection). tokens.css mirrors these values
 * as `--rp-*` custom properties; tokens.test.ts keeps the two in step. No other colour exists
 * anywhere in apps/web (guards.test.ts).
 */

export const COLORS = {
  vellum: '#F2F1EC',
  sheet: '#FFFFFF',
  ink: '#111111',
  graphite: '#6B6B66',
  red: '#E10600',
  blue: '#1F4BFF',
} as const;

export type ColorToken = keyof typeof COLORS;

export const FONT_FAMILIES = {
  display: "'Space Grotesk', ui-sans-serif, system-ui, 'Segoe UI', Arial, sans-serif",
  body: "'Inter', ui-sans-serif, system-ui, 'Segoe UI', Arial, sans-serif",
  mono: "'Space Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
} as const;

export type FontToken = keyof typeof FONT_FAMILIES;

/** The weights fonts.ts loads for each family. */
export const FONT_WEIGHTS = {
  display: [700],
  body: [400, 500, 600],
  mono: [400, 700],
} as const satisfies Record<FontToken, readonly number[]>;

/** Text sizes in CSS px. tokens.css states them in rem (px / 16) so they follow the user's zoom. */
export const TEXT_SIZES_PX = {
  'display-1': 64,
  'display-2': 40,
  'display-3': 28,
  'body-lg': 18,
  body: 16,
  label: 16,
  mono: 16,
} as const;

export type TextToken = keyof typeof TEXT_SIZES_PX;

/** `var(--rp-<colour>)`, for the rare inline style that needs a token (the specimen swatches). */
export function colorVar(token: ColorToken): string {
  return `var(--rp-${token})`;
}
