import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Polices every UI file in apps/web, including later slices':
 * - colour literals live only in tokens.ts and tokens.css
 * - font-size only through var(--rp-text-*); font-family only through var(--rp-font-*)
 * - no `font` shorthand and no inline fontSize / fontFamily
 * - no font loaded over http(s): fonts come only from @fontsource
 * Test files are skipped: they quote the very literals they check.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'public']);
const SCANNED = /\.(?:ts|tsx|css|html)$/;
const TEST_FILE = /\.test\.tsx?$/;
const TOKEN_FILES = new Set(['src/look/tokens.ts', 'src/look/tokens.css']);

function uiFiles(dir = WEB_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) files.push(...uiFiles(path));
    } else if (SCANNED.test(entry.name) && !TEST_FILE.test(entry.name)) {
      files.push(relative(WEB_ROOT, path).split(sep).join('/'));
    }
  }
  return files.sort();
}

const NAMED_COLOURS = [
  'aqua',
  'beige',
  'black',
  'blue',
  'brown',
  'coral',
  'crimson',
  'cyan',
  'fuchsia',
  'gold',
  'gray',
  'green',
  'grey',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lime',
  'magenta',
  'maroon',
  'navy',
  'olive',
  'orange',
  'pink',
  'plum',
  'purple',
  'red',
  'salmon',
  'silver',
  'tan',
  'teal',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'canvas',
  'canvastext',
  'buttonface',
  'buttontext',
  'highlight',
];
const HEX_LITERAL = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/gi;
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/gi;
// A colour-bearing property (CSS or a camelCase style key), then its value.
const COLOUR_PROPERTY =
  /(?:^|[\s{;,'"`])(color|background(?:-color)?|backgroundColor|border(?:-[a-z]+)*|border[A-Z]\w*|outline(?:-color)?|outlineColor|fill|stroke|text-decoration(?:-color)?|textDecoration(?:Color)?|caret-color|caretColor|accent-color|accentColor|text-emphasis-color|column-rule(?:-color)?)['"]?\s*:\s*([^;}\n]+)/g;
const NAMED_COLOUR = new RegExp(`(?<![\\w-])(?:${NAMED_COLOURS.join('|')})(?![\\w-])`, 'i');

function colourLiterals(text: string): string[] {
  const found = [
    ...[...text.matchAll(HEX_LITERAL)].map((m) => m[0]),
    ...[...text.matchAll(COLOUR_FUNCTION)].map((m) => m[0]),
  ];
  for (const match of text.matchAll(COLOUR_PROPERTY)) {
    const value = (match[2] ?? '').replace(/var\([^)]*\)/g, '');
    const named = NAMED_COLOUR.exec(value);
    if (named) found.push(`${match[1] ?? ''}: ${named[0]}`);
  }
  return found;
}

function fontViolations(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/font-size\s*:\s*([^;}"'\n]+)/gi)) {
    const value = (match[1] ?? '').replace(/!important/, '').trim();
    if (!/^var\(--rp-text-[a-z0-9-]+\)$/.test(value)) found.push(match[0]);
  }
  for (const match of text.matchAll(/font-family\s*:\s*([^;}"\n]+)/gi)) {
    const value = (match[1] ?? '').replace(/!important/, '').trim();
    if (!/^(?:var\(--rp-font-(?:display|body|mono)\)|inherit)$/.test(value)) found.push(match[0]);
  }
  for (const match of text.matchAll(/(?:^|[\s{;,'"`])(font)['"]?\s*:/g))
    found.push(match[0].trim());
  for (const match of text.matchAll(/\bfont(?:Size|Family)\b/g)) found.push(match[0]);
  return found;
}

function remoteFontUrls(text: string): string[] {
  const patterns = [
    /@import\s+(?:url\()?\s*['"]?https?:\/\/[^\s'")]+/gi,
    /url\(\s*['"]?https?:\/\/[^\s'")]+/gi,
    /<link\b[^>]*\bhref\s*=\s*['"]?https?:\/\/[^\s'">]+/gi,
    /https?:\/\/[^\s'"`)]*(?:fonts?\.|\.woff2?\b|\.ttf\b|\.otf\b|typekit|fontawesome)[^\s'"`)]*/gi,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[0]));
}

describe('only tokens and self-hosted fonts', () => {
  const files = uiFiles();
  const read = (file: string) => readFileSync(join(WEB_ROOT, file), 'utf8');

  it('scans the web sources, the look and both HTML pages', () => {
    for (const file of [
      'index.html',
      'look.html',
      'src/main.tsx',
      'src/look/base.css',
      'src/look/tokens.css',
      'src/look/Button.tsx',
      'src/look/Specimen.tsx',
    ]) {
      expect(files, file).toContain(file);
    }
  });

  it('catches each kind of violation it polices', () => {
    expect(colourLiterals('a { color: #fff; }')).toHaveLength(1);
    expect(colourLiterals('a { border: 1px solid rgba(0, 0, 0, 0.2); }')).toHaveLength(1);
    expect(colourLiterals('a { background: white; }')).toHaveLength(1);
    expect(colourLiterals("style={{ backgroundColor: 'red' }}")).toHaveLength(1);
    expect(colourLiterals('a { color: var(--rp-red); border-color: currentColor; }')).toEqual([]);
    expect(colourLiterals('<div id="root"></div> href="#main" &#10003;')).toEqual([]);

    expect(fontViolations('a { font-size: 14px; }')).toHaveLength(1);
    expect(fontViolations('a { font-size: var(--rp-text-body); }')).toEqual([]);
    expect(fontViolations('a { font: 700 16px Inter; }')).toHaveLength(1);
    expect(fontViolations('<p style={{ fontSize: 12 }}>')).toHaveLength(1);
    expect(fontViolations("a { font-family: 'Comic Sans MS'; }")).toHaveLength(1);
    expect(fontViolations('a { font-family: var(--rp-font-mono); font-weight: 700; }')).toEqual([]);

    expect(
      remoteFontUrls('@import url(https://fonts.googleapis.com/css2?family=Inter);'),
    ).not.toEqual([]);
    expect(remoteFontUrls('<link href="https://fonts.gstatic.com" rel="preconnect">')).not.toEqual(
      [],
    );
    expect(remoteFontUrls("src: url('https://cdn.example.com/inter.woff2')")).not.toEqual([]);
    expect(remoteFontUrls("import '@fontsource/inter/400.css';")).toEqual([]);
  });

  it('allows colour literals only in tokens.ts and tokens.css', () => {
    const offenders = files
      .filter((file) => !TOKEN_FILES.has(file))
      .flatMap((file) => colourLiterals(read(file)).map((hit) => `${file}: ${hit}`));
    expect(offenders).toEqual([]);
  });

  it('sets font-size and font-family only through tokens, never the shorthand or inline', () => {
    const offenders = files.flatMap((file) =>
      fontViolations(read(file)).map((hit) => `${file}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  it('loads no font over http(s)', () => {
    const offenders = files.flatMap((file) =>
      remoteFontUrls(read(file)).map((hit) => `${file}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });
});
