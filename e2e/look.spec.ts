/// <reference lib="dom" />
// The Look, checked in the browser on every nav route at 1280 and 375 px, signed in, with data on
// every page: no visible text under 16 px; only the six palette tokens (or transparent) for text,
// background and drawn border colours; every text pair at 4.5:1, or 3:1 for large text; and no
// horizontal scroll at 375 px.
//
// Every page also loads under the production CSP with zero `securitypolicyviolation` events.
// The auth screens get the same checks: the sign-in notice and the form after it, the forced
// password change (and its refusal), the lock screen (and a wrong password), Change password,
// Settings with a notice on, and the app shell's 429.
//
// Playwright runs spec files in name order against one api and database, so this file runs before
// shell.spec.ts and smoke.spec.ts, which both need a fresh install. It therefore starts an api of
// its own (tsx, without pnpm) on a database of its own in the run folder, seeds it through that
// api, and routes the browser's `/api` calls to it. The pages, with their CSP, come from the
// config's server: the production build served by the api.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { loadCatalog } from '@rampart/catalog';
import { REGULATION } from '@rampart/rules/poam';
import {
  approvalResponseSchema,
  assessmentViewSchema,
  assetResponseSchema,
  diagramResponseSchema,
  evidenceItemResponseSchema,
  poamItemResponseSchema,
  policyResponseSchema,
  providerResponseSchema,
  requirementWriteResponseSchema,
  responsibilityRowResponseSchema,
  revisionResponseSchema,
  roleResponseSchema,
  sspProfileResponseSchema,
  systemProfileResponseSchema,
  userResponseSchema,
} from '../apps/api/src/contract/index.ts';
import { BODY_TEXT_MIN, LARGE_TEXT_MIN, contrastRatio } from '../apps/web/src/look/contrast.ts';
import { COLORS, TEXT_SIZES_PX } from '../apps/web/src/look/tokens.ts';
import { SSP_TABS } from '../apps/web/src/pages/ssp/tabs.ts';
import { api, ensureOk, signIn, type Api } from './helpers/api';
import {
  firstObjectiveId,
  planHold,
  requirementById,
  requirementByNist,
  utcDatePlus,
} from './helpers/plan';

type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/api');
const HOST = '127.0.0.1';
const API_PORT = process.env.E2E_LOOK_API_PORT ?? '3293';
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

/** Starts an api (tsx, no watch, no web app), on a database in the run folder. */
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
      // As the config's api: real limits, raised so the suite never trips them.
      RATE_LIMIT_MULTIPLIER: '100',
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

/** What the seed made that the checks name by id. */
interface Seeded {
  /** The requirement whose matrix row names the provider as ESP. */
  espRequirementId: string;
  providerId: string;
}

/** How far the seeded next review date lies from today: in the past, so the review is overdue. */
const REVIEW_DUE_IN_DAYS = -5;
const APPROVED_ON = utcDatePlus(-400);
const PLANNED = 'Block remote reach to CUI from personal devices with the MDM policy in Q2.';
const NA_RATIONALE = 'No objective of this requirement is N/A.';
/** A statement in the future tense, so Lint & export shows a future-tense finding. */
const FUTURE_REQUIREMENT_ID = catalog.requirements[5]?.id ?? '';
const FUTURE_STATEMENT = `${FUTURE_REQUIREMENT_ID} will be enforced by the MDM policy; the date is TBD.`;

/** The sign-in notice the auth screens show: several sentences and a line break, as a real one. */
const NOTICE =
  'You are accessing an information system that processes Controlled Unclassified Information.\n' +
  'Use of this system is monitored, recorded and subject to audit. Unauthorised use is ' +
  'prohibited and may result in criminal and civil penalties. By continuing you consent to ' +
  'these terms.';
/** The seeded admin, and the seeded contributor, whose admin-set password is temporary. */
const LENA = { email: 'lena@example.test', password: 'look-check-pass-1' };
const COLE = { email: 'cole@example.test', password: 'contributor-pass-1' };
/** On the bundled blocklist, so the forced change refuses it. */
const TOO_COMMON = 'QwertyUiop12';
const SIGNED_OUT: StorageState = { cookies: [], origins: [] };

/** A value for every SSP profile field, so every group's form is filled. */
const SSP_PROFILE = {
  categorization: 'Moderate impact for confidentiality, low for integrity',
  securityOfficer: 'Sam Security',
  securityOfficerEmail: 'sam@example.test',
  organizationAddress: '1 Engineering Way, Springfield, VA 22150',
  organizationPhone: '+1 (703) 555-0142',
  cuiCategories: 'CTI (Controlled Technical Information); EXPT (Export Controlled)',
  cuiLocations: 'The enclave file server and the two engineering workstations.',
  cuiEntryExit: 'CUI arrives from the prime over DoD SAFE and leaves the same way.',
  topologyNarrative: 'One flat VLAN behind the boundary firewall, with no wireless inside it.',
  dataFlowNarrative: 'Drawings move from SAFE to the file server, then to the CAD workstations.',
  inventoryReference: 'https://inventory.example.test/enclave',
  maintenanceStatement: 'The IT lead maintains every asset; the MSP patches monthly.',
  reviewCadenceMonths: 12,
  nextReviewDate: utcDatePlus(REVIEW_DUE_IN_DAYS),
};

/**
 * Puts something on every page: blockers, an item, evidence, a policy, a profile, two users, and
 * the SSP workspace's profile, roles, assets, provider, matrix row, diagrams and document control.
 */
async function seed(request: APIRequestContext): Promise<Seeded> {
  await ensureOk(
    await request.post('/api/setup', {
      data: { ...LENA, displayName: 'Lena Look' },
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
  await client.write(
    'PATCH',
    `/api/assessment/requirements/${FUTURE_REQUIREMENT_ID}`,
    { implementationStatement: FUTURE_STATEMENT },
    requirementWriteResponseSchema,
  );

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
  await ensureOk(
    await client.send('POST', `/api/evidence/${cui.item.id}/references`, {
      location: '\\\\enclave-fs01\\cui\\diagrams\\network-diagram-final-v3.vsdx',
      note: 'Kept on the enclave file server.',
    }),
    'POST evidence reference',
  );

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
      ...COLE,
      displayName: 'Cole Contributor',
      role: 'contributor',
    },
    userResponseSchema,
  );
  await client.write(
    'PATCH',
    `/api/assessment/requirements/${barred.id}`,
    { plannedImplementation: PLANNED, naRationale: NA_RATIONALE },
    requirementWriteResponseSchema,
  );
  return seedSspWorkspace(client, barred.id, cui.item.id);
}

/** A 1×1 PNG, so the network diagram is an image the SSP can embed. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Fills every SSP tab: the profile in every group (a past next review date), two roles (one
 * privileged), one asset per category, a provider named as ESP on `espRequirementId`, a PNG
 * network diagram and the CUI item as the data flow, a manual revision and an approval.
 */
async function seedSspWorkspace(
  client: Api,
  espRequirementId: string,
  cuiEvidenceId: string,
): Promise<Seeded> {
  await client.write('PATCH', '/api/ssp/profile', SSP_PROFILE, sspProfileResponseSchema);

  const roles = [
    {
      title: 'System administrator',
      person: 'Ira IT',
      responsibilities: 'Accounts, patching and backups.',
      userCount: 2,
      privileged: true,
    },
    {
      title: 'Design engineer',
      person: null,
      responsibilities: 'CAD work on CUI drawings.',
      userCount: 12,
      privileged: false,
    },
  ];
  for (const role of roles) await client.write('POST', '/api/ssp/roles', role, roleResponseSchema);

  const assets = [
    { name: 'CAD workstation', category: 'cui', assetType: 'Workstation', location: 'Lab 2' },
    { name: 'Boundary firewall', category: 'spa', assetType: 'Firewall', location: 'Server room' },
    { name: 'Print server', category: 'crma', assetType: 'Server', location: 'Server room' },
    { name: 'CNC mill controller', category: 'specialized', assetType: 'OT', location: 'Shop' },
    {
      name: 'Guest Wi-Fi',
      category: 'out_of_scope',
      assetType: 'Network',
      location: 'Lobby',
      outOfScopeJustification: 'Physically separate network; no CUI.',
    },
  ];
  for (const asset of assets) {
    await client.write(
      'POST',
      '/api/ssp/assets',
      { owner: 'Ira IT', treatment: null, ...asset },
      assetResponseSchema,
    );
  }

  const { provider } = await client.write(
    'POST',
    '/api/ssp/providers',
    {
      name: 'Northwind Cloud',
      providerType: 'cloud',
      fedrampStatus: 'FedRAMP Moderate',
      services: 'Hosted email and file sync for the enclave.',
      agreementReference: 'MSA-2026-014',
    },
    providerResponseSchema,
  );
  await client.write(
    'PUT',
    `/api/ssp/responsibilities/${encodeURIComponent(espRequirementId)}`,
    { party: 'esp', providerId: provider.id, note: 'Northwind controls the external links.' },
    responsibilityRowResponseSchema,
  );

  const network = await client.write(
    'POST',
    '/api/evidence',
    {
      title: 'Enclave network diagram',
      description: 'Boundary, VLAN and workstations.',
      containsCui: false,
      objectiveIds: [],
    },
    evidenceItemResponseSchema,
  );
  await ensureOk(
    await client.upload(
      `/api/evidence/${network.item.id}/versions`,
      'enclave-network.png',
      PNG_BYTES,
    ),
    'upload network diagram',
  );
  await client.write(
    'POST',
    '/api/ssp/diagrams',
    {
      evidenceId: network.item.id,
      kind: 'network',
      caption: 'Enclave network, boundary to workstations',
      version: null,
    },
    diagramResponseSchema,
  );
  await client.write(
    'POST',
    '/api/ssp/diagrams',
    {
      evidenceId: cuiEvidenceId,
      kind: 'data_flow',
      caption: 'CUI path from SAFE to the CAD workstations',
      version: null,
    },
    diagramResponseSchema,
  );

  await client.write(
    'POST',
    '/api/ssp/revisions',
    { date: utcDatePlus(-3), description: 'Added the enclave diagrams and the asset inventory.' },
    revisionResponseSchema,
  );
  await client.write(
    'POST',
    '/api/ssp/approvals',
    { name: 'Avery Approver', title: 'Chief Executive Officer', approvedOn: APPROVED_ON },
    approvalResponseSchema,
  );
  return { espRequirementId, providerId: provider.id };
}

// ---------- checks ----------

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

/**
 * Records every `securitypolicyviolation` in each page, from before the app's first script runs.
 * Playwright injects init scripts outside the page's CSP, so the collector never trips it.
 */
async function collectCspViolations(context: BrowserContext) {
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(
        `csp: ${event.effectiveDirective} blocked ${event.blockedURI || '(inline)'} at ${event.sourceFile || document.location.pathname}:${String(event.lineNumber)}`,
      );
    });
  });
}

/** The CSP violations the current page has recorded since it loaded. */
async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window.__cspViolations ?? [])]);
}

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

/** Every Look rule and CSP violation the current page shows, each line named by width and view. */
async function measure(page: Page, width: number, name: string): Promise<string[]> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const facts = await page.evaluate(collectFacts);
  const lines = [...violations(facts, width), ...(await cspViolations(page))];
  return lines.map((line) => `${String(width)}px ${name} ${line}`);
}

// ---------- the test ----------

/** A browser context signed in as the seeded admin, its `/api` calls routed to the look api. */
async function lookContext(
  browser: Browser,
  baseURL: string | undefined,
  storageState: StorageState,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    storageState,
  });
  await collectCspViolations(context);
  // Pages come from the config's server; their api calls go to the look api.
  // Only the api's own paths: module URLs such as /@fs/…/apps/api/src/contract also hold "/api/".
  await context.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `${API_ORIGIN}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    },
  );
  return context;
}

/** `/ssp?tab=<id>` for each SSP tab, in tab order. */
const SSP_TAB_VIEWS = SSP_TABS.map((tab) => ({
  name: `/ssp?tab=${tab.id}`,
  path: `/ssp?tab=${tab.id}`,
  label: tab.label,
}));

test.describe('look', () => {
  let storageState: StorageState;
  let seeded: Seeded;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(180_000);
    await startApi();
    // Seed through the look api once; both tests sign in with its session cookie.
    const request = await playwright.request.newContext({ baseURL: API_ORIGIN });
    seeded = await seed(request);
    storageState = await request.storageState();
    await request.dispose();
  });
  test.afterAll(async () => {
    await stopApi();
  });

  test('look holds on every route', async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const context = await lookContext(browser, testInfo.project.use.baseURL, storageState);
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
    const views: { name: string; path: string; label?: string }[] = [
      ...routes.map((path) => ({ name: path, path })),
      // The requirement detail: the objective radios, notes, statement and the two SSP fields.
      {
        name: '/assessment (detail)',
        path: `/assessment?family=${barred.family}&req=${encodeURIComponent(barred.id)}`,
      },
      // Every SSP tab, each with its seeded data.
      ...SSP_TAB_VIEWS,
    ];

    const found: string[] = [];
    let checked = 0;
    let cspChecked = 0;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of views) {
        await open(page, view.path);
        if (view.label !== undefined) {
          await expect(page.getByRole('tab', { selected: true })).toHaveText(view.label);
        }
        if (view.path === '/ssp?tab=export') {
          // Measure the pre-export check with its findings on screen, not while it runs.
          await expect(page.locator('[data-tone] [data-message]').first()).toBeVisible();
        }
        const facts = await page.evaluate(collectFacts);
        checked += facts.texts.length;
        cspChecked += 1;
        const lines = [...violations(facts, width), ...(await cspViolations(page))];
        for (const line of lines) found.push(`${String(width)}px ${view.name} ${line}`);
      }
      if (width === PHONE) {
        // The phone nav is behind Menu.
        await open(page, '/');
        await page.getByRole('button', { name: 'Menu' }).click();
        await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
        const facts = await page.evaluate(collectFacts);
        const lines = [...violations(facts, width), ...(await cspViolations(page))];
        for (const line of lines) found.push(`${String(width)}px / (menu open) ${line}`);
      }
    }
    // The pages were served under the strict CSP, so zero violations means something.
    const served = await context.request.get('/');
    await context.close();

    expect(served.headers()['content-security-policy']).toMatch(/^default-src 'self'; /);
    expect(checked, 'text elements checked').toBeGreaterThan(100);
    expect(cspChecked, 'pages checked for CSP violations').toBe(views.length * WIDTHS.length);
    expect([...new Set(found)], [...new Set(found)].join('\n')).toEqual([]);
  });

  test('seeded workspace shows its data', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const context = await lookContext(browser, testInfo.project.use.baseURL, storageState);
    const page = await context.newPage();
    await page.setViewportSize({ width: WIDTHS[0], height: 900 });

    // Identification & roles: the profile, the roles table and its totals.
    await open(page, '/ssp?tab=identification');
    await expect(page.getByLabel('System security officer', { exact: true })).toHaveValue(
      SSP_PROFILE.securityOfficer,
    );
    const roles = page.getByRole('table', { name: 'System roles' });
    await expect(roles.getByRole('row', { name: /System administrator/ })).toContainText('Yes');
    await expect(roles.getByRole('row', { name: /Design engineer/ })).toContainText('No');
    await expect(page.getByText('14 users · 2 privileged')).toBeVisible();

    // Environment: a narrative and both diagrams, one embedded and one CUI reference.
    await open(page, '/ssp?tab=environment');
    await expect(page.getByLabel('Network topology')).toHaveValue(SSP_PROFILE.topologyNarrative);
    await expect(page.getByRole('row', { name: /Enclave network/ })).toContainText(
      'Embedded image',
    );
    await expect(page.getByRole('row', { name: /CUI path/ })).toContainText(
      'Referenced — contains CUI',
    );

    // Assets: one per category, the out-of-scope one with its justification.
    await open(page, '/ssp?tab=assets');
    await expect(page.getByText('5 assets')).toBeVisible();
    const outOfScope = page.getByRole('table', { name: /Out-of-Scope Assets · 1/ });
    await expect(outOfScope.getByRole('row', { name: /Guest Wi-Fi/ })).toContainText(
      'Physically separate network; no CUI.',
    );

    // Service providers & matrix: the provider, and the ESP row that names it.
    await open(page, '/ssp?tab=providers');
    const providers = page.getByRole('table', { name: 'Service providers · 1' });
    await expect(providers.getByRole('row', { name: /Northwind Cloud/ })).toContainText(
      'FedRAMP Moderate',
    );
    await expect(page.getByLabel(`Party for ${seeded.espRequirementId}`)).toHaveValue('esp');
    await expect(page.getByLabel(`Provider for ${seeded.espRequirementId}`)).toHaveValue(
      seeded.providerId,
    );
    await expect(page.getByText('1 of 110 assigned')).toBeVisible();

    // Document control: the overdue review, a manual revision and an approval.
    await open(page, '/ssp?tab=document-control');
    await expect(page.getByText('Review overdue', { exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: /Added the enclave diagrams/ })).toContainText(
      'Manual',
    );
    await expect(page.getByRole('row', { name: /Avery Approver/ })).toContainText(APPROVED_ON);

    // Lint & export: the future-tense statement's finding, linked to its requirement.
    await open(page, '/ssp?tab=export');
    const future = page
      .locator('[data-tone]')
      .filter({ has: page.getByText('Future-tense statements · 1', { exact: true }) });
    await expect(future).toHaveAttribute('data-tone', 'info');
    await expect(future.locator('[data-message]')).toHaveText([
      `${FUTURE_REQUIREMENT_ID} says "will", "TBD" (future tense).`,
    ]);
    const family = requirementById(catalog, FUTURE_REQUIREMENT_ID).family;
    await expect(
      future.getByRole('link', { name: `Open ${FUTURE_REQUIREMENT_ID}`, exact: true }),
    ).toHaveAttribute('href', `/assessment?family=${family}&req=${FUTURE_REQUIREMENT_ID}`);

    // Dashboard: the overdue review in Needs attention, linking to document control.
    await open(page, '/');
    const overdue = page.getByRole('link', { name: /^SSP review overdue: due / });
    await expect(overdue).toHaveText(
      `SSP review overdue: due ${SSP_PROFILE.nextReviewDate} · ${String(-REVIEW_DUE_IN_DAYS)} days overdue`,
    );
    await expect(overdue).toHaveAttribute('href', '/ssp?tab=document-control');

    // The assessment detail shows both new fields on 3.1.20.
    const barred = requirementByNist(catalog, '3.1.20');
    await open(page, `/assessment?family=${barred.family}&req=${encodeURIComponent(barred.id)}`);
    await expect(page.getByLabel('Planned implementation')).toHaveValue(PLANNED);
    await expect(page.getByLabel('N/A rationale')).toHaveValue(NA_RATIONALE);
    await context.close();
  });

  test('auth screens hold the look', async ({ browser, playwright }, testInfo) => {
    test.setTimeout(180_000);
    const baseURL = testInfo.project.use.baseURL;
    const requests: APIRequestContext[] = [];
    const lookApi = async (state?: StorageState) => {
      const request = await playwright.request.newContext({
        baseURL: API_ORIGIN,
        ...(state === undefined ? {} : { storageState: state }),
      });
      requests.push(request);
      return request;
    };

    // The admin turns the notice on, through the look api.
    const admin = await api(await lookApi(storageState));
    await ensureOk(
      await admin.send('PUT', '/api/settings/sign-in-notice', { text: NOTICE }),
      'PUT notice',
    );
    // Cole's password is temporary, so his session lands on the forced change.
    const cole = await lookApi();
    expect((await signIn(cole, COLE.email, COLE.password)).mustChangePassword).toBe(true);
    // A second session for Lena, locked, so the seeded one stays open.
    const locked = await lookApi();
    await signIn(locked, LENA.email, LENA.password);
    expect((await (await api(locked)).send('POST', '/api/session/lock')).status()).toBe(204);

    const contexts = {
      signedOut: await lookContext(browser, baseURL, SIGNED_OUT),
      cole: await lookContext(browser, baseURL, await cole.storageState()),
      locked: await lookContext(browser, baseURL, await locked.storageState()),
      admin: await lookContext(browser, baseURL, storageState),
      tooMany: await lookContext(browser, baseURL, SIGNED_OUT),
    };
    // The shell's 429: the session read is refused with a wait. A later route wins.
    await contexts.tooMany.route(
      (url) => url.pathname === '/api/session',
      (route) =>
        route.fulfill({
          status: 429,
          json: {
            error: {
              code: 'too_many_attempts',
              message: 'Too many requests. Try again later.',
              requestId: 'look-check',
              details: { retryAfterSeconds: 42 },
            },
          },
        }),
    );

    const lockHeading = (page: Page) =>
      page.getByRole('heading', { level: 1, name: 'Session locked' });
    const screens: {
      name: string;
      context: BrowserContext;
      path: string;
      ready: (page: Page) => Promise<void>;
    }[] = [
      {
        name: 'sign-in notice',
        context: contexts.signedOut,
        path: '/',
        ready: async (page) => {
          await expect(page.getByRole('region', { name: 'System use notice' })).toBeVisible();
        },
      },
      {
        name: 'sign-in form after the notice',
        context: contexts.signedOut,
        path: '/',
        ready: async (page) => {
          await page.getByRole('button', { name: 'Acknowledge and continue' }).click();
          await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
        },
      },
      {
        name: 'forced change password',
        context: contexts.cole,
        path: '/',
        ready: async (page) => {
          await expect(page.getByTestId('change-password-forced')).toBeVisible();
        },
      },
      {
        name: 'forced change password (refused)',
        context: contexts.cole,
        path: '/',
        ready: async (page) => {
          await page.getByLabel('Current password').fill(COLE.password);
          await page.getByLabel('New password', { exact: true }).fill(TOO_COMMON);
          await page.getByLabel('Confirm new password').fill(TOO_COMMON);
          await page.getByRole('button', { name: 'Change password' }).click();
          await expect(
            page.getByText('This password is too common. Choose another.', { exact: true }),
          ).toBeVisible();
        },
      },
      {
        name: 'lock screen',
        context: contexts.locked,
        path: '/',
        ready: async (page) => {
          await expect(lockHeading(page)).toBeVisible();
        },
      },
      {
        name: 'lock screen (wrong password)',
        context: contexts.locked,
        path: '/',
        ready: async (page) => {
          await expect(lockHeading(page)).toBeVisible();
          await page.getByLabel('Password', { exact: true }).fill('not-the-password-at-all');
          await page.getByRole('button', { name: 'Unlock' }).click();
          await expect(page.getByText('Password is incorrect.', { exact: true })).toBeVisible();
        },
      },
      {
        name: '/account/password',
        context: contexts.admin,
        path: '/account/password',
        ready: async (page) => {
          await expect(
            page.getByRole('heading', { level: 1, name: 'Change password' }),
          ).toBeVisible();
        },
      },
      {
        name: '/settings (notice on)',
        context: contexts.admin,
        path: '/settings',
        ready: async (page) => {
          await expect(page.getByLabel('Notice text')).toHaveValue(NOTICE);
          await expect(page.getByText(/^Loading/)).toHaveCount(0);
        },
      },
      {
        name: 'too many requests',
        context: contexts.tooMany,
        path: '/',
        ready: async (page) => {
          await expect(
            page.getByText('Too many requests. Try again in 42 seconds.', { exact: true }),
          ).toBeVisible();
          await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
        },
      },
    ];

    const found: string[] = [];
    let cspChecked = 0;
    for (const width of WIDTHS) {
      for (const screen of screens) {
        const page = await screen.context.newPage();
        await page.setViewportSize({ width, height: 900 });
        await page.goto(screen.path);
        await screen.ready(page);
        found.push(...(await measure(page, width, screen.name)));
        cspChecked += 1;
        await page.close();
      }
    }
    for (const context of Object.values(contexts)) await context.close();

    // Turn the notice off again.
    await ensureOk(
      await admin.send('PUT', '/api/settings/sign-in-notice', { text: null }),
      'clear notice',
    );
    for (const request of requests) await request.dispose();

    expect(cspChecked, 'screens checked for CSP violations').toBe(screens.length * WIDTHS.length);
    expect([...new Set(found)], [...new Set(found)].join('\n')).toEqual([]);
  });
});
