import { render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';
import { DashboardPage } from '../pages/dashboard/DashboardPage';
import { SspPage } from '../pages/ssp/SspPage';
import {
  BODY_TEXT_MIN,
  BODY_TEXT_PAIRS,
  contrastRatio,
  LARGE_TEXT_MIN,
  LARGE_TEXT_PAIRS,
  type TextPair,
} from './contrast';
import { DimensionRuler, rulerPercent } from './DimensionRuler';
import { FeatureControlFrame } from './FeatureControlFrame';
import { InspectionStamp } from './InspectionStamp';
import { InspectionStrip } from './InspectionStrip';
import { COLORS, type ColorToken } from './tokens';

// The pages-mounted tests render the whole signed-in app; on a loaded machine that can pass
// vitest's 5 s default, so give this file more room.
vi.setConfig({ testTimeout: 15_000 });

// Spy on the real page modules, so the test can tell that App mounts them rather than the
// generic placeholder (both show the same h1).
vi.mock('../pages/dashboard/DashboardPage', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../pages/dashboard/DashboardPage')>();
  return { DashboardPage: vi.fn(mod.DashboardPage) };
});
vi.mock('../pages/ssp/SspPage', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../pages/ssp/SspPage')>();
  return { SspPage: vi.fn(mod.SspPage) };
});

// The real scale: floor and max from the catalog's scoring, threshold from REGULATION.
const FLOOR = -203;
const MAX = 110;
const THRESHOLD = 88;
const MINUS = '−';

/** An element's inline `left` as a number of percent (jsdom rounds it to 6 digits). */
function leftPercent(el: Element | null | undefined): number {
  const left = (el as HTMLElement | null | undefined)?.style.left ?? '';
  expect(left).toMatch(/%$/);
  return parseFloat(left);
}

function ruler(value: number | null, bounds = { floor: FLOOR, max: MAX, threshold: THRESHOLD }) {
  const { container } = render(<DimensionRuler value={value} {...bounds} />);
  const root = screen.getByRole('img');
  return { container, root };
}

describe('rulerPercent edges', () => {
  it('maps floor to 0, max to 100 and values between linearly', () => {
    expect(rulerPercent(FLOOR, FLOOR, MAX)).toBe(0);
    expect(rulerPercent(MAX, FLOOR, MAX)).toBe(100);
    expect(rulerPercent(0, -100, 100)).toBe(50);
    expect(rulerPercent(72, FLOOR, MAX)).toBeCloseTo((275 / 313) * 100, 10);
  });

  it('clamps values outside the scale, and reads NaN as the floor', () => {
    expect(rulerPercent(FLOOR - 1, FLOOR, MAX)).toBe(0);
    expect(rulerPercent(-10_000, FLOOR, MAX)).toBe(0);
    expect(rulerPercent(MAX + 1, FLOOR, MAX)).toBe(100);
    expect(rulerPercent(Number.POSITIVE_INFINITY, FLOOR, MAX)).toBe(100);
    expect(rulerPercent(Number.NaN, FLOOR, MAX)).toBe(0);
  });

  it('throws a RangeError when floor >= max, or a bound is not a number', () => {
    expect(() => rulerPercent(0, 110, 110)).toThrow(RangeError);
    expect(() => rulerPercent(0, 111, 110)).toThrow(RangeError);
    expect(() => rulerPercent(0, Number.NaN, 110)).toThrow(RangeError);
    expect(() => rulerPercent(0, FLOOR, Number.NaN)).toThrow(RangeError);
  });
});

describe('ruler scale', () => {
  it('ticks every multiple of 25 in range, with majors at multiples of 100', () => {
    const { container } = ruler(72);
    const ticks = [...container.querySelectorAll<HTMLElement>('[data-tick]')];
    expect(ticks.map((t) => Number(t.dataset.tick))).toEqual([
      -200, -175, -150, -125, -100, -75, -50, -25, 0, 25, 50, 75, 100,
    ]);
    const majors = ticks.filter((t) => t.dataset.major === 'true').map((t) => t.dataset.tick);
    expect(majors).toEqual(['-200', '-100', '0', '100']);
    // Each tick sits at its place on the scale.
    expect(leftPercent(ticks[0])).toBeCloseTo(rulerPercent(-200, FLOOR, MAX), 4);
  });

  it('labels floor, −100, 0 and max as HTML text, with no SVG <text>', () => {
    const { container } = ruler(72);
    const labels = [...container.querySelectorAll('[data-scale-label]')].map((l) => l.textContent);
    expect(labels).toEqual([`${MINUS}203`, `${MINUS}100`, '0', '110']);
    expect(container.querySelectorAll('svg text')).toHaveLength(0);
    expect(screen.getByText(`${String(THRESHOLD)} CONDITIONAL`)).toBeInTheDocument();
  });

  it('takes its numbers from props: another scale gets its own ticks and labels', () => {
    const { container } = ruler(30, { floor: -40, max: 60, threshold: 50 });
    const ticks = [...container.querySelectorAll<HTMLElement>('[data-tick]')];
    expect(ticks.map((t) => t.dataset.tick)).toEqual(['-25', '0', '25', '50']);
    const labels = [...container.querySelectorAll('[data-scale-label]')].map((l) => l.textContent);
    // −100 is out of range, so it has no label.
    expect(labels).toEqual([`${MINUS}40`, '0', '60']);
    expect(screen.getByText('50 CONDITIONAL')).toBeInTheDocument();
    expect(screen.getByText('+20')).toBeInTheDocument();
  });

  it('labels a floor of 0 once', () => {
    const { container } = ruler(5, { floor: 0, max: 10, threshold: 8 });
    const labels = [...container.querySelectorAll('[data-scale-label]')].map((l) => l.textContent);
    expect(labels).toEqual(['0', '10']);
  });

  it('places the threshold line and the marker at their values', () => {
    const { container } = ruler(72);
    const line = container.querySelector('[data-part="threshold"]');
    expect(leftPercent(line)).toBeCloseTo(rulerPercent(THRESHOLD, FLOOR, MAX), 4);
    const marker = container.querySelector('[data-part="marker"]');
    expect(leftPercent(marker)).toBeCloseTo(rulerPercent(72, FLOOR, MAX), 4);
  });
});

describe('ruler gap and label', () => {
  it('at 72 marks YOU 72 and a +16 gap to the line', () => {
    const { container, root } = ruler(72);
    expect(screen.getByText('YOU 72')).toBeInTheDocument();
    const gap = container.querySelector<HTMLElement>('[data-part="gap"]');
    expect(gap).not.toBeNull();
    expect(within(root).getByText('+16')).toBeInTheDocument();
    expect(leftPercent(gap)).toBeCloseTo(rulerPercent(72, FLOOR, MAX), 4);
    expect(root).toHaveAccessibleName(
      `SPRS 72 on a scale from ${MINUS}203 to 110. Conditional line at 88. 16 points short.`,
    );
  });

  it('at 87 reads +1 and "1 point short"', () => {
    const { root } = ruler(87);
    expect(within(root).getByText('+1')).toBeInTheDocument();
    expect(root).toHaveAccessibleName(
      `SPRS 87 on a scale from ${MINUS}203 to 110. Conditional line at 88. 1 point short.`,
    );
  });

  it.each([88, 107, 110])('at %i has a marker but no gap', (value) => {
    const { container, root } = ruler(value);
    expect(screen.getByText(`YOU ${String(value)}`)).toBeInTheDocument();
    expect(container.querySelector('[data-part="marker"]')).not.toBeNull();
    expect(container.querySelector('[data-part="gap"]')).toBeNull();
    expect(root).toHaveAccessibleName(
      `SPRS ${String(value)} on a scale from ${MINUS}203 to 110. Conditional line at 88. At or above the Conditional line.`,
    );
  });

  it('writes a negative score with U+2212 and keeps an off-scale marker on the scale', () => {
    const { container, root } = ruler(-250);
    expect(screen.getByText(`YOU ${MINUS}250`)).toBeInTheDocument();
    expect(within(root).getByText('+338')).toBeInTheDocument();
    expect(leftPercent(container.querySelector('[data-part="marker"]'))).toBe(0);
    expect(root).toHaveAccessibleName(
      `SPRS ${MINUS}250 on a scale from ${MINUS}203 to 110. Conditional line at 88. 338 points short.`,
    );
  });

  it('with null has no marker and no gap, and says there is no score yet', () => {
    const { container, root } = ruler(null);
    expect(container.querySelector('[data-part="marker"]')).toBeNull();
    expect(container.querySelector('[data-part="gap"]')).toBeNull();
    expect(screen.queryByText(/^YOU/)).not.toBeInTheDocument();
    expect(root).toHaveAccessibleName(
      `No SPRS score yet on a scale from ${MINUS}203 to 110. Conditional line at 88.`,
    );
    // The scale and the line still show.
    expect(screen.getByText('88 CONDITIONAL')).toBeInTheDocument();
  });

  it('refuses a scale whose floor is not below its max', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<DimensionRuler value={1} floor={10} max={10} threshold={5} />)).toThrow(
      RangeError,
    );
  });
});

describe('feature control frame', () => {
  function frame(measured: number | null) {
    const { container } = render(<FeatureControlFrame measured={measured} lsl={88} usl={110} />);
    const root = container.firstElementChild as HTMLElement;
    const cells = [...root.children].map((c) => c.textContent);
    return { root, cells };
  }

  it('reads OUT OF TOL at 87', () => {
    const { root, cells } = frame(87);
    expect(cells).toEqual(['SPRS', 'MEAS 87', 'LSL 88', 'USL 110', 'OUT OF TOL']);
    expect(root).toHaveAttribute('data-status', 'out_of_tol');
  });

  it.each([88, 110])('reads IN TOL at %i (limits are inclusive)', (measured) => {
    const { root, cells } = frame(measured);
    expect(cells).toEqual(['SPRS', `MEAS ${String(measured)}`, 'LSL 88', 'USL 110', 'IN TOL']);
    expect(root).toHaveAttribute('data-status', 'in_tol');
  });

  it('reads OUT OF TOL above the USL', () => {
    expect(frame(111).root).toHaveAttribute('data-status', 'out_of_tol');
  });

  it('reads NO READING with MEAS — for null', () => {
    const { root, cells } = frame(null);
    expect(cells).toEqual(['SPRS', 'MEAS —', 'LSL 88', 'USL 110', 'NO READING']);
    expect(root).toHaveAttribute('data-status', 'no_reading');
  });

  it('writes negatives with U+2212, never a hyphen', () => {
    const { container } = render(<FeatureControlFrame measured={-40} lsl={-100} usl={110} />);
    const root = container.firstElementChild as HTMLElement;
    const cells = [...root.children].map((c) => c.textContent);
    expect(cells).toEqual(['SPRS', `MEAS ${MINUS}40`, `LSL ${MINUS}100`, 'USL 110', 'IN TOL']);
    expect(root.textContent).not.toContain('-');
  });
});

describe("inspector's stamp", () => {
  it.each([
    ['hold', 'HOLD', '2 BLOCKERS'],
    ['accept', 'ACCEPT', 'CONDITIONAL'],
  ] as const)('%s reads %s with its detail', (verdict, word, detail) => {
    render(<InspectionStamp verdict={verdict} detail={detail} />);
    const stamp = screen.getByRole('img', { name: `Inspector's stamp: ${word}` });
    expect(stamp).toHaveAttribute('data-variant', verdict);
    expect(within(stamp).getByText(word)).toBeInTheDocument();
    expect(within(stamp).getByText(detail)).toBeInTheDocument();
  });
});

describe('inspection strip', () => {
  it('shows each label with its value, in order', () => {
    render(
      <InspectionStrip
        entries={[
          { label: 'Inspection report', value: 'IR-0001' },
          { label: 'Characteristics', value: '320' },
        ]}
      />,
    );
    const terms = screen.getAllByRole('term').map((t) => t.textContent);
    const values = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(terms).toEqual(['Inspection report', 'Characteristics']);
    expect(values).toEqual(['IR-0001', '320']);
  });
});

// ---- tokens and contrast -------------------------------------------------------------------

const LOOK_DIR = dirname(fileURLToPath(import.meta.url));
const NEW_CSS = [
  'DimensionRuler.module.css',
  'FeatureControlFrame.module.css',
  'InspectionStamp.module.css',
  'InspectionStrip.module.css',
];
const COLOR_NAMES = Object.keys(COLORS) as ColorToken[];
const LARGE_SIZES = new Set(['display-1', 'display-2', 'display-3']);

interface CssRule {
  selector: string;
  decls: Map<string, string>;
}

/** Innermost rule blocks (rules inside @media come out with their own selectors). */
function cssRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const decls = new Map<string, string>();
    for (const part of (m[2] ?? '').split(';')) {
      const at = part.indexOf(':');
      if (at > 0) decls.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    return { selector: (m[1] ?? '').trim(), decls };
  });
}

/** The `--rp-*` properties tokens.css defines. */
function definedTokens(): Set<string> {
  const css = readFileSync(join(LOOK_DIR, 'tokens.css'), 'utf8');
  return new Set([...css.matchAll(/(--rp-[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? ''));
}

function colorToken(value: string | undefined): ColorToken | undefined {
  const m = /^var\(--rp-([a-z]+)\)$/.exec(value ?? '');
  return COLOR_NAMES.find((name) => name === m?.[1]);
}

/** Problems with a stylesheet: unknown tokens, raw sizes, and text pairs off the contrast rule. */
function cssProblems(css: string): { problems: string[]; pairs: number } {
  const problems: string[] = [];
  const tokens = definedTokens();
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)\)/gi)) {
    if (!tokens.has(m[1] ?? '')) problems.push(`unknown token ${m[1] ?? ''}`);
  }
  let pairs = 0;
  for (const rule of cssRules(css)) {
    const size = rule.decls.get('font-size');
    if (size !== undefined && !/^var\(--rp-text-[a-z0-9-]+\)$/.test(size)) {
      problems.push(`${rule.selector}: font-size ${size}`);
    }
    for (const [prop, value] of rule.decls) {
      if (/^(?:color|background(?:-color)?|fill|stroke)$/.test(prop)) {
        if (!colorToken(value) && !/^(?:transparent|currentColor|none)$/.test(value)) {
          problems.push(`${rule.selector}: ${prop} ${value}`);
        }
      }
    }
    const fg = colorToken(rule.decls.get('color'));
    if (!rule.decls.has('color')) continue;
    // Text colour is always set with its background, so the pair is known.
    const bg = colorToken(rule.decls.get('background') ?? rule.decls.get('background-color'));
    if (!fg || !bg) {
      problems.push(`${rule.selector}: color without a token background`);
      continue;
    }
    pairs += 1;
    const pair: TextPair = { fg, bg };
    const large = LARGE_SIZES.has(/--rp-text-([a-z0-9-]+)/.exec(size ?? '')?.[1] ?? '');
    const same = (p: TextPair) => p.fg === fg && p.bg === bg;
    const allowed = BODY_TEXT_PAIRS.some(same) || (large && LARGE_TEXT_PAIRS.some(same));
    const ratio = contrastRatio(COLORS[pair.fg], COLORS[pair.bg]);
    if (!allowed || ratio < (large ? LARGE_TEXT_MIN : BODY_TEXT_MIN)) {
      problems.push(`${rule.selector}: ${fg} on ${bg} (${ratio.toFixed(2)})`);
    }
  }
  return { problems, pairs };
}

describe('tokens and contrast', () => {
  it('catches the problems it polices', () => {
    expect(
      cssProblems('.a { color: var(--rp-red); background: var(--rp-vellum); }').problems,
    ).toHaveLength(1);
    expect(
      cssProblems(
        '.a { color: var(--rp-red); background: var(--rp-vellum); font-size: var(--rp-text-display-3); }',
      ).problems,
    ).toEqual([]);
    expect(cssProblems('.a { color: var(--rp-ink); }').problems).toHaveLength(1);
    expect(
      cssProblems('.a { color: var(--rp-ink); background: var(--rp-sheet); }').problems,
    ).toEqual([]);
    expect(cssProblems('.a { font-size: 12px; }').problems).toHaveLength(1);
    expect(cssProblems('.a { border-color: var(--rp-orange); }').problems).toHaveLength(1);
    expect(cssProblems('.a { background: var(--rp-sheet); }').problems).toEqual([]);
  });

  it.each(NEW_CSS)('%s uses only look tokens, and each text pair passes', (file) => {
    const { problems, pairs } = cssProblems(readFileSync(join(LOOK_DIR, file), 'utf8'));
    expect(problems).toEqual([]);
    expect(pairs).toBeGreaterThan(0);
  });
});

// ---- pages mounted -------------------------------------------------------------------------

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada', role: 'admin' };

describe('pages mounted', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              path === '/api/session'
                ? { setupRequired: false, user: ADMIN, csrfToken: 'csrf-1' }
                : { status: 'ok', db: 'ok' },
            ),
          ),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    ['/', 'Dashboard', DashboardPage],
    ['/ssp', 'SSP', SspPage],
  ] as const)('%s renders its page module with the h1 %s', async (path, title, Page) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <AuthedApp />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(Page).toHaveBeenCalled();
  });
});
