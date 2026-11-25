/// <reference lib="dom" />
// The Look, checked in the browser on every nav route at 1280 and 375 px, signed in, with data on
// every page: no visible text under 16 px; only the six palette tokens (or transparent) for text,
// background and drawn border colours; every text pair at 4.5:1, or 3:1 for large text; and no
// horizontal scroll at 375 px.
//
// Playwright runs spec files in name order against one api and database, so this file runs before
// shell.spec.ts and smoke.spec.ts, which both need a fresh install. It therefore starts an api of
// its own (the config's entry point, without pnpm) on a database of its own in the run folder,
// seeds it through that api, and routes the browser's `/api` calls to it. The pages come from the
// config's web app, so only one Vite serves the repo.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { loadCatalog } from '@rampart/catalog';
import { REGULATION } from '@rampart/rules/poam';
import {
  assessmentViewSchema,
  evidenceItemResponseSchema,
  poamItemResponseSchema,
  policyResponseSchema,
  systemProfileResponseSchema,
  userResponseSchema,
} from '../apps/api/src/contract/index.ts';
import { BODY_TEXT_MIN, LARGE_TEXT_MIN, contrastRatio } from '../apps/web/src/look/contrast.ts';
import { COLORS, TEXT_SIZES_PX } from '../apps/web/src/look/tokens.ts';
import { api, ensureOk, type Api } from './helpers/api';
import {
  firstObjectiveId,
  planHold,
  requirementById,
  requirementByNist,
  utcDatePlus,
} from './helpers/plan';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/api');
const HOST = '127.0.0.1';
const API_PORT =
  process.env.E2E_LOOK_API_PORT ?? String(Number(process.env.E2E_API_PORT ?? '3291') + 2);
const API_ORIGIN = `http://${HOST}:${API_PORT}`;

const WIDTHS = [1280, 375] as const;
const PHONE = 375;
const MIN_TEXT_PX = TEXT_SIZES_PX.body;
/** WCAG large text: 24 px, or 18.66 px (14 pt) bold. */
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;

const catalog = loadCatalog();
const TOKEN_HEX = new Set(Object.values(COLORS).map((hex) => hex.toUpperCase()));

// ---------- the api ----------

let server: ChildProcess | null = null;
const serverOutput: string[] = [];

/** Starts the api the way the config does (tsx, no watch), on a database in the run folder. */
async function startApi() {
  const runDir = join(process.env.E2E_RUN_DIR ?? '', 'look');
  mkdirSync(runDir, { recursive: true });
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      API_PORT,
      DATABASE_PATH: join(runDir, 'look.sqlite'),
      STORAGE_PATH: join(runDir, 'files'),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  child.stdout.on('data', (chunk: Buffer) => serverOutput.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => serverOutput.push(chunk.toString()));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`The api exited:
${serverOutput.join('')}`);
    try {
      if ((await fetch(`${API_ORIGIN}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`The api did not answer:
${serverOutput.join('')}`);
}

async function stopApi() {
  const child = server;
  if (child === null || child.exitCode !== null) return;
  await new Promise<void>((done) => {
    child.once('exit', () => {
      done();
    });
    child.kill();
  });
}

// ---------- data ----------

/** Puts something on every page: blockers, an item, evidence, a policy, a profile, two users. */
async function seed(request: APIRequestContext): Promise<Api> {
  await ensureOk(
    await request.post('/api/setup', {
      data: { email: 'lena@example.test', displayName: 'Lena Look', password: 'look-check-pass-1' },
    }),
    'POST /api/setup',
  );
  const client = await api(request);

  const barred = requirementByNist(catalog, '3.1.20');
  const plan = planHold(catalog, { score: 72, uiRequirement: barred, poamCount: 3 });
  const notMet = new Set(
    [...plan.notMet, barred.id].map((id) => firstObjectiveId(requirementById(catalog, id))),
  );
  const objectives = catalog.requirements.flatMap((r) => r.objectives.map((o) => o.id));
  for (let i = 0; i < objectives.length; i += 8) {
    await Promise.all(
      objectives.slice(i, i + 8).map(async (id) => {
        await ensureOk(
          await client.send('PUT', `/api/assessment/objectives/${encodeURIComponent(id)}`, {
            status: notMet.has(id) ? 'not_met' : 'met',
            note: null,
          }),
          `PUT objective ${id}`,
        );
      }),
    );
  }
  await client.write(
    'PATCH',
    '/api/assessment',
    { conditionalStatusDate: utcDatePlus(-10) },
    assessmentViewSchema,
  );
  const [target] = plan.poamTargets;
  await client.write(
    'POST',
    '/api/poam',
    {
      requirementId: target,
      plan: 'Enable session lock after 15 minutes of inactivity on every workstation.',
      due: utcDatePlus(REGULATION.closeoutWindowDays.value - 30),
      milestones: [{ title: 'Pilot on two workstations', due: utcDatePlus(20), doneOn: null }],
    },
    poamItemResponseSchema,
  );
  for (const r of catalog.requirements.slice(0, 5)) {
    await client.send('PATCH', `/api/assessment/requirements/${r.id}`, {
      implementationStatement: `${r.id} is met by the documented access procedure.`,
    });
  }

  const evidence = await client.write(
    'POST',
    '/api/evidence',
    {
      title: 'Firewall rule export',
      description: 'Exported monthly.',
      containsCui: false,
      objectiveIds: [firstObjectiveId(catalog.requirements[0] ?? barred)],
    },
    evidenceItemResponseSchema,
  );
  await ensureOk(
    await client.upload(
      `/api/evidence/${evidence.item.id}/versions`,
      'firewall-rules-with-a-long-file-name.txt',
      Buffer.from('deny ip any any\n'),
    ),
    'upload evidence',
  );
  const cui = await client.write(
    'POST',
    '/api/evidence',
    { title: 'Network diagram', description: null, containsCui: true, objectiveIds: [] },
    evidenceItemResponseSchema,
  );
  await client.send('POST', `/api/evidence/${cui.item.id}/references`, {
    location: '\\\\enclave-fs01\\cui\\diagrams\\network-diagram-final-v3.vsdx',
    note: 'Kept on the enclave file server.',
  });

  const policy = await client.write(
    'POST',
    '/api/policies',
    {
      title: 'Access control policy',
      description: 'Who may reach CUI, and how.',
      requirementIds: [catalog.requirements[0]?.id ?? barred.id],
    },
    policyResponseSchema,
  );
  await ensureOk(
    await client.upload(
      `/api/policies/${policy.item.id}/versions`,
      'access-control-policy.md',
      Buffer.from('# Access\n'),
    ),
    'upload policy',
  );

  await client.write(
    'PATCH',
    '/api/system-profile',
    {
      systemName: 'Contoso Engineering Enclave',
      systemIdentifier: 'CEE-01',
      cageCode: '1ABC2',
      systemOwnerEmail: 'lena@example.test',
    },
    systemProfileResponseSchema,
  );
  await client.write(
    'POST',
    '/api/users',
    {
      email: 'cole@example.test',
      displayName: 'Cole Contributor',
      role: 'contributor',
      password: 'contributor-pass-1',
    },
    userResponseSchema,
  );
  return client;
}

// ---------- checks ----------

interface Facts {
  scrollWidth: number;
  viewportWidth: number;
  texts: { el: string; fontSize: number; fontWeight: number; color: string; background: string }[];
  colors: { el: string; property: string; value: string }[];
}

/** Reads, in the page, every visible element's text size, colours and nearest opaque background. */
function collectFacts(): Facts {
  const describe = (el: Element) => {
    const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
    const cls = el.classList.item(0);
    return `<${el.tagName.toLowerCase()}${cls === null ? '' : `.${cls}`}> "${text}"`;
  };
  const alpha = (value: string) => {
    const match = /rgba?\(([^)]+)\)/.exec(value);
    const parts = match?.[1]?.split(/[ ,/]+/).filter(Boolean) ?? [];
    return parts[3] === undefined ? 1 : Number(parts[3]);
  };
  const background = (el: Element): string => {
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      const value = getComputedStyle(node).backgroundColor;
      if (alpha(value) === 1) return value;
    }
    return 'rgb(255, 255, 255)';
  };

  const facts: Facts = {
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    viewportWidth: window.innerWidth,
    texts: [],
    colors: [],
  };
  // The page background lives on <html> and <body>, so they are checked with their descendants.
  const elements = [
    document.documentElement,
    document.body,
    ...document.body.querySelectorAll('*'),
  ];
  for (const el of elements) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const rect = el.getBoundingClientRect();
    // A visually hidden control (1 px, clipped) is never seen.
    if (rect.width <= 1 || rect.height <= 1) continue;
    const style = getComputedStyle(el);
    facts.colors.push({
      el: describe(el),
      property: 'background-color',
      value: style.backgroundColor,
    });
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const width = parseFloat(style.getPropertyValue(`border-${side}-width`));
      const line = style.getPropertyValue(`border-${side}-style`);
      if (width > 0 && line !== 'none' && line !== 'hidden') {
        facts.colors.push({
          el: describe(el),
          property: `border-${side}-color`,
          value: style.getPropertyValue(`border-${side}-color`),
        });
      }
    }
    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
    );
    const field =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement;
    const fieldText = field && (el.value !== '' || ('placeholder' in el && el.placeholder !== ''));
    if (ownText || fieldText) {
      facts.colors.push({ el: describe(el), property: 'color', value: style.color });
      facts.texts.push({
        el: describe(el),
        fontSize: parseFloat(style.fontSize),
        fontWeight: Number(style.fontWeight),
        color: style.color,
        background: background(el),
      });
    }
  }
  return facts;
}

/** `#RRGGBB` and alpha of a computed `rgb()`/`rgba()` value; `null` for anything else. */
function parseColor(value: string): { hex: string; alpha: number } | null {
  const match = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?\s*\)$/.exec(value);
  if (match === null) return null;
  const [, r, g, b, a] = match;
  const hex =
    `#${[r, g, b].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  return { hex, alpha: a === undefined ? 1 : Number(a) };
}

/** Every Look rule the page breaks, one line each. */
function violations(facts: Facts, width: number): string[] {
  const found: string[] = [];
  for (const { el, property, value } of facts.colors) {
    const color = parseColor(value);
    const ok =
      color !== null && (color.alpha === 0 || (color.alpha === 1 && TOKEN_HEX.has(color.hex)));
    if (!ok) found.push(`palette: ${property} ${value} on ${el}`);
  }
  for (const text of facts.texts) {
    if (text.fontSize < MIN_TEXT_PX) found.push(`size: ${String(text.fontSize)}px text ${text.el}`);
    const fg = parseColor(text.color);
    const bg = parseColor(text.background);
    if (fg === null || bg === null || fg.alpha === 0) continue;
    const large =
      text.fontSize >= LARGE_PX || (text.fontSize >= LARGE_BOLD_PX && text.fontWeight >= 700);
    const ratio = contrastRatio(fg.hex, bg.hex);
    const min = large ? LARGE_TEXT_MIN : BODY_TEXT_MIN;
    if (ratio < min) {
      found.push(
        `contrast: ${ratio.toFixed(2)}:1 (needs ${String(min)}) ${fg.hex} on ${bg.hex} ${text.el}`,
      );
    }
  }
  if (width === PHONE && facts.scrollWidth > width) {
    found.push(`scroll: page is ${String(facts.scrollWidth)}px wide at ${String(width)}px`);
  }
  return found;
}

/** Opens a view and waits until its data is on screen and the fonts are in. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

// ---------- the test ----------

test.describe('look', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await startApi();
  });
  test.afterAll(async () => {
    await stopApi();
  });

  test('look holds on every route', async ({ browser, playwright }, testInfo) => {
    test.setTimeout(180_000);
    // Seed through the look api, then hand its session cookie to the browser.
    const request = await playwright.request.newContext({ baseURL: API_ORIGIN });
    await seed(request);
    const { baseURL } = testInfo.project.use;
    const context = await browser.newContext({
      ...(baseURL === undefined ? {} : { baseURL }),
      storageState: await request.storageState(),
    });
    await request.dispose();
    // Pages come from the config's web app; their api calls go to the look api.
    // Only the api's own paths: module URLs such as /@fs/…/apps/api/src/contract also hold "/api/".
    await context.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: `${API_ORIGIN}${url.pathname}${url.search}` });
        await route.fulfill({ response });
      },
    );
    const page = await context.newPage();

    // Every route the Primary nav offers, as the signed-in user sees it.
    await page.setViewportSize({ width: WIDTHS[0], height: 900 });
    await open(page, '/');
    const routes = await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    expect(routes).toContain('/');
    expect(routes).toContain('/ssp');

    const barred = requirementByNist(catalog, '3.1.20');
    const views = [
      ...routes.map((path) => ({ name: path, path })),
      // The requirement detail: the objective radios, notes and statement.
      {
        name: '/assessment (detail)',
        path: `/assessment?family=${barred.family}&req=${encodeURIComponent(barred.id)}`,
      },
    ];

    const found: string[] = [];
    let checked = 0;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of views) {
        await open(page, view.path);
        const facts = await page.evaluate(collectFacts);
        checked += facts.texts.length;
        for (const line of violations(facts, width))
          found.push(`${String(width)}px ${view.name} ${line}`);
      }
      if (width === PHONE) {
        // The phone nav is behind Menu.
        await open(page, '/');
        await page.getByRole('button', { name: 'Menu' }).click();
        await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
        const facts = await page.evaluate(collectFacts);
        for (const line of violations(facts, width))
          found.push(`${String(width)}px / (menu open) ${line}`);
      }
    }
    await context.close();

    expect(checked, 'text elements checked').toBeGreaterThan(100);
    expect([...new Set(found)], [...new Set(found)].join('\n')).toEqual([]);
  });
});
