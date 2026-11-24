import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COLORS, FONT_FAMILIES, TEXT_SIZES_PX } from './tokens';

const here = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(join(here, 'tokens.css'), 'utf8');
const fontsTs = readFileSync(join(here, 'fonts.ts'), 'utf8');

/** Every `--rp-*` custom property declared in tokens.css, name → value. */
function cssCustomProperties(css: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const match of css.matchAll(/(--rp-[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) props.set(name, value.trim());
  }
  return props;
}

const HEX = /^#[0-9a-f]{3,8}$/i;
const COLOUR_VALUE = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(.*\))$/i;

describe('token values', () => {
  const props = cssCustomProperties(tokensCss);

  it('has exactly the six plan colours, in tokens.ts and tokens.css alike', () => {
    expect(COLORS).toEqual({
      vellum: '#F2F1EC',
      sheet: '#FFFFFF',
      ink: '#111111',
      graphite: '#6B6B66',
      red: '#E10600',
      blue: '#1F4BFF',
    });

    const cssColours = [...props].filter(([, value]) => COLOUR_VALUE.test(value));
    expect(cssColours).toHaveLength(6);
    for (const [name, hex] of Object.entries(COLORS)) {
      const value = props.get(`--rp-${name}`);
      expect(value, `--rp-${name}`).toMatch(HEX);
      expect(value?.toUpperCase()).toBe(hex);
    }
  });

  it('sets every text size at 16 px or more, with the plan scale, mirrored in tokens.css', () => {
    expect(Object.keys(TEXT_SIZES_PX).length).toBeGreaterThan(0);
    for (const px of Object.values(TEXT_SIZES_PX)) expect(px).toBeGreaterThanOrEqual(16);
    expect(new Set(Object.values(TEXT_SIZES_PX))).toEqual(new Set([64, 40, 28, 18, 16]));

    const cssSizes = [...props].filter(([name]) => name.startsWith('--rp-text-'));
    expect(cssSizes.map(([name]) => name).sort()).toEqual(
      Object.keys(TEXT_SIZES_PX)
        .map((key) => `--rp-text-${key}`)
        .sort(),
    );
    for (const [key, px] of Object.entries(TEXT_SIZES_PX)) {
      expect(props.get(`--rp-text-${key}`), `--rp-text-${key}`).toBe(`${String(px / 16)}rem`);
    }
  });

  it('gives each of the three font families a system fallback, mirrored in tokens.css', () => {
    const generic = { display: 'sans-serif', body: 'sans-serif', mono: 'monospace' } as const;
    const named = { display: 'Space Grotesk', body: 'Inter', mono: 'Space Mono' } as const;
    expect(Object.keys(FONT_FAMILIES).sort()).toEqual(['body', 'display', 'mono']);
    for (const key of ['display', 'body', 'mono'] as const) {
      const stack = FONT_FAMILIES[key].split(',').map((part) => part.trim().replace(/['"]/g, ''));
      expect(stack[0]).toBe(named[key]);
      expect(stack.length).toBeGreaterThanOrEqual(3);
      expect(stack.at(-1)).toBe(generic[key]);
      expect(props.get(`--rp-font-${key}`)).toBe(FONT_FAMILIES[key]);
    }
  });

  it('imports exactly the six font weights from @fontsource', () => {
    const imports = [...fontsTs.matchAll(/import\s+['"](@fontsource\/[^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    expect(imports.sort()).toEqual(
      [
        '@fontsource/inter/400.css',
        '@fontsource/inter/500.css',
        '@fontsource/inter/600.css',
        '@fontsource/space-grotesk/700.css',
        '@fontsource/space-mono/400.css',
        '@fontsource/space-mono/700.css',
      ].sort(),
    );
  });
});
