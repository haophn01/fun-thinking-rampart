// The plan's Verification path, in the browser, against the run's fresh api and web app. Each
// named step goes through the UI; bulk writes go through the api as the same signed-in user.
// Scores are planned from the catalog and the regulation data, never from spelled-out points.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Response } from '@playwright/test';
import { loadCatalog, type Requirement } from '@rampart/catalog';
import { SSP_LINT_RULES, scoreMax } from '@rampart/rules';
import { REGULATION } from '@rampart/rules/poam';
import {
  NIST_STATUS_LABELS,
  PRODUCT_NAME,
  SYSTEM_PROFILE_FIELDS,
  approvalResponseSchema,
  assessmentViewSchema,
  assetResponseSchema,
  auditPageSchema,
  diagramsResponseSchema,
  documentControlSchema,
  evidenceItemResponseSchema,
  objectiveWriteResponseSchema,
  poamItemResponseSchema,
  policyListSchema,
  providerResponseSchema,
  requirementWriteResponseSchema,
  responsibilityRowResponseSchema,
  sessionResponseSchema,
  sspFileName,
  sspLintResponseSchema,
  sspProfileResponseSchema,
  type AssessmentView,
  type AuditEvent,
  type DiagramLink,
  nistImplementationStatus,
  type SspLintResponse,
  type SystemProfileFieldKey,
} from '../apps/api/src/contract/index.ts';
import { docxPart, pngOf } from '../apps/api/ssp/testing/docx-text.ts';
import { api, linkDiagram, uploadEvidence, type Api } from './helpers/api';
import { docxMedia, docxText } from './helpers/docx';
import {
  firstObjectiveId,
  planHold,
  pointsOf,
  requirementById,
  requirementByNist,
  utcDatePlus,
} from './helpers/plan';

const catalog = loadCatalog();
const THRESHOLD = REGULATION.conditionalMinScore.value;
/** The plan's Verification: the score that holds with 3.1.20 Not Met. */
const HOLD_SCORE = 72;
const BARRED = requirementByNist(catalog, '3.1.20');
const POAM_COUNT = 3;
const PLAN = planHold(catalog, { score: HOLD_SCORE, uiRequirement: BARRED, poamCount: POAM_COUNT });

const ADMIN = {
  email: 'ada@example.test',
  displayName: 'Ada Admin',
  password: 'smoke-test-pass-1',
};

const PROFILE: Record<SystemProfileFieldKey, string> = {
  systemName: 'Contoso Engineering Enclave',
  systemIdentifier: 'CEE-01',
  organizationName: 'Contoso Machining LLC',
  cageCode: '1ABC2',
  description: 'Workstations and a file server for drawings.',
  authorizationBoundary: 'The engineering VLAN and its file server.',
  environment: 'On-premises, Windows 11 and Windows Server 2022.',
  interconnections: 'None beyond the corporate firewall.',
  informationTypes: 'Technical drawings (FCI only in this test).',
  systemOwner: 'Ada Admin',
  systemOwnerEmail: 'ada@example.test',
  securityContact: 'Sam Security',
  securityContactEmail: 'sam@example.test',
};

/** Every requirement's statement; `&` and `<` check the export keeps them. */
const statementFor = (r: Requirement) => `${r.id} is met by documented controls & <procedures>.`;

const EVIDENCE_FILE = {
  name: 'firewall-rules.txt',
  bytes: Buffer.from('permit tcp 10.0.0.0/24 any eq 443\ndeny ip any any\n'),
};
const POLICY_FILE = {
  name: 'access-policy.md',
  bytes: Buffer.from('# Access policy\n\nLeast privilege.\n'),
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The export v2 outline: its ten level-1 headings, exact text, in document order. */
const SSP_HEADINGS = [
  '1. System identification',
  '2. System environment',
  'CMMC: CUI description',
  'CMMC: Asset inventory',
  'CMMC: External service providers and responsibilities',
  '3. Requirements',
  '4. Record of changes',
  'Approvals',
  'Appendix A — Assessment status',
  'Appendix B — Assessment objectives',
];

/** The role added through the Identification UI. */
const ROLE = {
  title: 'Enclave administrator',
  person: 'Ira IT',
  responsibilities: 'Accounts, patching and backups.',
  userCount: 3,
};

/** The review was due this many days ago, so the pre-export check flags it. */
const REVIEW_OVERDUE_DAYS = 2;
const SSP_PROFILE = {
  categorization: 'Moderate impact for confidentiality',
  securityOfficer: 'Sam Security',
  securityOfficerEmail: 'sam@example.test',
  organizationAddress: '1 Engineering Way, Springfield, VA 22150',
  organizationPhone: '+1 (703) 555-0142',
  cuiCategories: 'CTI (Controlled Technical Information)',
  cuiLocations: 'The enclave file server.',
  cuiEntryExit: 'CUI arrives from the prime over DoD SAFE.',
  topologyNarrative: 'One VLAN behind the boundary firewall.',
  dataFlowNarrative: 'Drawings move from SAFE to the file server.',
  inventoryReference: 'https://inventory.example.test/enclave',
  maintenanceStatement: 'The IT lead maintains every asset.',
  reviewCadenceMonths: 12,
  nextReviewDate: utcDatePlus(-REVIEW_OVERDUE_DAYS),
};

/** One asset per CMMC category, in `ASSET_CATEGORIES` order. */
const ASSETS = [
  { name: 'CAD workstation', category: 'cui', assetType: 'Workstation' },
  { name: 'Boundary firewall', category: 'spa', assetType: 'Firewall' },
  { name: 'Print server', category: 'crma', assetType: 'Server' },
  { name: 'CNC mill controller', category: 'specialized', assetType: 'OT' },
  {
    name: 'Guest Wi-Fi',
    category: 'out_of_scope',
    assetType: 'Network',
    outOfScopeJustification: 'Physically separate network; no CUI.',
  },
];

const NETWORK_PNG = {
  title: 'Enclave network diagram',
  fileName: 'enclave-network.png',
  bytes: pngOf(40, 30),
  caption: 'Enclave network, boundary to workstations',
};
const OTHER_PDF = {
  title: 'Rack elevation',
  fileName: 'rack-elevation.pdf',
  bytes: Buffer.from('%PDF-1.4\n% rack elevation\n%%EOF\n'),
  caption: 'Server rack elevation',
};
const CUI_CAPTION = 'CUI path from SAFE to the file server';
const CUI_LOCATION = '\\\\enclave-fs01\\cui\\network-diagram.vsdx';
const APPROVAL = {
  name: 'Avery Approver',
  title: 'Chief Executive Officer',
  approvedOn: utcDatePlus(-30),
};

/** A requirement whose statement says what is still to come: a future-tense finding. */
const FUTURE_REQUIREMENT = requirementById(catalog, catalog.requirements[1]?.id ?? '');
const FUTURE_STATEMENT = `${FUTURE_REQUIREMENT.id} will be met once MFA is rolled out; the date is TBD.`;

const pathOf = (response: Response) => decodeURIComponent(new URL(response.url()).pathname);

/** Waits for the answer to `method path` (exact, decoded). Start it before the action. */
function answer(page: Page, method: string, path: string | RegExp) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      (typeof path === 'string' ? pathOf(response) === path : path.test(pathOf(response))),
  );
}

async function setObjective(client: Api, objectiveId: string, status: 'met' | 'not_met') {
  await client.write(
    'PUT',
    `/api/assessment/objectives/${encodeURIComponent(objectiveId)}`,
    { status, note: null },
    objectiveWriteResponseSchema,
  );
}

/** Runs the writes a few at a time; the api applies them one by one either way. */
async function inBatches<T>(items: readonly T[], write: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += 8) await Promise.all(items.slice(i, i + 8).map(write));
}

const readView = (client: Api) => client.read('/api/assessment', assessmentViewSchema);

/** Opens the dashboard and waits until it has its data. */
async function openDashboard(page: Page) {
  const loaded = answer(page, 'GET', '/api/poam');
  await page.goto('/');
  await loaded;
  await expect(page.getByTestId('score-value')).toBeVisible();
}

/** Marks a requirement's first objective in the Assessment UI and waits for the save. */
async function markInUi(page: Page, requirement: Requirement, label: 'Met' | 'Not Met') {
  const objectiveId = firstObjectiveId(requirement);
  const loaded = answer(page, 'GET', '/api/assessment');
  await page.goto(
    `/assessment?family=${requirement.family}&req=${encodeURIComponent(requirement.id)}`,
  );
  await loaded;
  const row = page.getByRole('listitem', { name: objectiveId, exact: true });
  const saved = answer(page, 'PUT', `/api/assessment/objectives/${objectiveId}`);
  await row.getByText(label, { exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(row.getByRole('radio', { name: label, exact: true })).toBeChecked();
}

/** A candidate row on the POA&M page, found by its exact requirement ID. */
const candidateRow = (page: Page, id: string) =>
  page
    .getByRole('list', { name: 'Candidates' })
    .getByRole('listitem')
    .filter({ has: page.getByText(id, { exact: true }) });

test('the score plan comes from the catalog data', () => {
  const notMetPoints = PLAN.notMet.reduce(
    (sum, id) => sum + pointsOf(requirementById(catalog, id)),
    0,
  );
  expect(scoreMax(catalog) - notMetPoints - pointsOf(BARRED)).toBe(HOLD_SCORE);
  expect(PLAN.poamTargets).toHaveLength(POAM_COUNT);
  expect(PLAN.notMet).not.toContain(BARRED.id);
  const afterFix =
    scoreMax(catalog) -
    PLAN.poamTargets.reduce((sum, id) => sum + pointsOf(requirementById(catalog, id)), 0);
  expect(afterFix).toBeGreaterThanOrEqual(THRESHOLD);
  expect(REGULATION.poamBarred.value).toContain(BARRED.id);
});

test.describe('verification path', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let client: Api;
  let adminId: string;
  const startedAt = new Date();
  const evidenceTitle = 'Firewall rule export';
  const cuiTitle = 'Network diagram (CUI)';
  const policyTitle = 'Access control policy';
  const linkedRequirement = requirementById(catalog, catalog.families[0]?.requirementIds[0] ?? '');
  /** The CUI evidence item, a location reference: linked as the data flow diagram. */
  let cuiEvidenceId = '';

  test.beforeAll(async ({ browser }, testInfo) => {
    const { baseURL } = testInfo.project.use;
    page = await browser.newPage(baseURL === undefined ? {} : { baseURL });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('set up the admin in the UI', async () => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: `Set up ${PRODUCT_NAME}` }),
    ).toBeVisible();
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Display name').fill(ADMIN.displayName);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByLabel('Confirm password').fill(ADMIN.password);
    const created = answer(page, 'POST', '/api/setup');
    await page.getByRole('button', { name: 'Create admin' }).click();
    expect((await created).ok()).toBe(true);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    client = await api(page);
    const session = sessionResponseSchema.parse(
      await (await page.request.get('/api/session')).json(),
    );
    adminId = session.user?.id ?? '';
    expect(session.user).toMatchObject({ displayName: ADMIN.displayName, role: 'admin' });
  });

  test('hold at 72 and 3.1.20 refused', async () => {
    test.setTimeout(120_000);
    const objectives = catalog.requirements.flatMap((r) => r.objectives.map((o) => o.id));
    await inBatches(objectives, (id) => setObjective(client, id, 'met'));
    await inBatches(PLAN.notMet, (id) =>
      setObjective(client, firstObjectiveId(requirementById(catalog, id)), 'not_met'),
    );
    const planned = (await readView(client)).evaluation.score;
    expect(planned.kind === 'scored' && planned.score).toBe(HOLD_SCORE + pointsOf(BARRED));

    await markInUi(page, BARRED, 'Not Met');

    const view = await readView(client);
    expect(view.evaluation.score.kind === 'scored' && view.evaluation.score.score).toBe(HOLD_SCORE);
    expect(view.evaluation.conditional.status).toBe('not_eligible');
    expect(view.evaluation.conditional.blockers).toContainEqual(
      expect.objectContaining({ code: 'poam_ineligible', requirementId: BARRED.id }),
    );

    await openDashboard(page);
    await expect(page.getByTestId('score-value')).toHaveText(String(HOLD_SCORE));
    await expect(page.getByRole('img', { name: "Inspector's stamp: HOLD" })).toBeVisible();
    await expect(page.getByText('OUT OF TOL', { exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Blockers' })).toContainText(
      `${BARRED.id} cannot go on a POA&M`,
    );

    const loaded = answer(page, 'GET', '/api/poam');
    await page.goto('/poam');
    await loaded;
    await expect(
      candidateRow(page, BARRED.id).getByRole('button', { name: 'Add to POA&M' }),
    ).toBeDisabled();

    const refused = await client.send('POST', '/api/poam', {
      requirementId: BARRED.id,
      plan: 'Try to defer the barred requirement.',
      due: utcDatePlus(60),
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'poam_ineligible' } });
  });

  test('accept with eligible POA&M items', async () => {
    await markInUi(page, BARRED, 'Met');
    const fixed = PLAN.notMet.filter((id) => !PLAN.poamTargets.includes(id));
    await inBatches(fixed, (id) =>
      setObjective(client, firstObjectiveId(requirementById(catalog, id)), 'met'),
    );

    const held = await readView(client);
    const score = held.evaluation.score.kind === 'scored' ? held.evaluation.score.score : null;
    expect(score).toBeGreaterThanOrEqual(THRESHOLD);
    expect(held.evaluation.conditional.status).toBe('not_eligible');
    expect(held.evaluation.conditional.blockers).toEqual(
      PLAN.poamTargets.map((id) =>
        expect.objectContaining({ code: 'poam_missing', requirementId: id }),
      ),
    );

    await openDashboard(page);
    await expect(page.getByRole('img', { name: "Inspector's stamp: HOLD" })).toBeVisible();
    await expect(page.getByText('IN TOL', { exact: true })).toBeVisible();
    for (const id of PLAN.poamTargets) {
      await expect(page.getByRole('list', { name: 'Blockers' })).toContainText(
        `${id} is Not Met and has no open POA&M item`,
      );
    }

    // One item through the POA&M UI, with a milestone; the other two through the api.
    const [uiTarget, ...apiTargets] = PLAN.poamTargets;
    const due = utcDatePlus(90);
    const loaded = answer(page, 'GET', '/api/poam');
    await page.goto('/poam');
    await loaded;
    await candidateRow(page, uiTarget ?? '')
      .getByRole('button', { name: 'Add to POA&M' })
      .click();
    const form = page.getByRole('form', { name: 'New POA&M item' });
    await form.getByLabel('Plan').fill('Turn on session lock on every engineering workstation.');
    await form.getByLabel('Due date').fill(due);
    await form.getByRole('button', { name: 'Add milestone' }).click();
    await form.getByLabel('Milestone 1 title').fill('Pilot on two workstations');
    await form.getByLabel('Milestone 1 due').fill(utcDatePlus(30));
    const created = answer(page, 'POST', '/api/poam');
    await form.getByRole('button', { name: 'Save item' }).click();
    const createdItem = poamItemResponseSchema.parse(await (await created).json()).item;
    expect(createdItem).toMatchObject({ requirementId: uiTarget, due, status: 'open' });
    expect(createdItem.milestones).toHaveLength(1);
    await expect(page.getByRole('list', { name: 'POA&M items' })).toContainText(uiTarget ?? '');

    const addItem = (id: string) =>
      client.write(
        'POST',
        '/api/poam',
        { requirementId: id, plan: `Remediate ${id}.`, due },
        poamItemResponseSchema,
      );
    const lastTarget = apiTargets.at(-1) ?? '';
    for (const id of apiTargets.slice(0, -1)) await addItem(id);

    // One Not Met requirement still has no item: still HOLD, for that one alone.
    const almost = await readView(client);
    expect(almost.evaluation.conditional.status).toBe('not_eligible');
    expect(almost.evaluation.conditional.blockers).toEqual([
      expect.objectContaining({ code: 'poam_missing', requirementId: lastTarget }),
    ]);
    await openDashboard(page);
    await expect(page.getByRole('img', { name: "Inspector's stamp: HOLD" })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Blockers' })).toContainText(
      `${lastTarget} is Not Met and has no open POA&M item`,
    );

    await addItem(lastTarget);

    const accepted = await readView(client);
    expect(accepted.evaluation.conditional.status).toBe('conditional');
    expect(accepted.openPoamRequirementIds).toEqual(PLAN.poamTargets);

    await openDashboard(page);
    await expect(page.getByRole('img', { name: "Inspector's stamp: ACCEPT" })).toBeVisible();
    await expect(page.getByText('Conditional status reachable', { exact: true })).toBeVisible();
    await expect(page.getByText(`POA&M · ${String(POAM_COUNT)} open`)).toBeVisible();
  });

  test('evidence hash and CUI refusal', async () => {
    const loaded = answer(page, 'GET', '/api/evidence');
    await page.goto('/evidence');
    await loaded;
    const form = page.getByRole('form', { name: 'New evidence item' });

    await form.getByLabel('Title').fill(evidenceTitle);
    const created = answer(page, 'POST', '/api/evidence');
    await form.getByRole('button', { name: 'Create evidence item' }).click();
    const item = evidenceItemResponseSchema.parse(await (await created).json()).item;
    const card = page.getByRole('listitem').filter({
      has: page.getByRole('heading', { name: evidenceTitle, exact: true }),
    });
    await card.getByRole('button', { name: `Details for ${evidenceTitle}` }).click();
    const uploaded = answer(page, 'POST', `/api/evidence/${item.id}/versions`);
    await card.getByLabel('Upload a file').setInputFiles({
      name: EVIDENCE_FILE.name,
      mimeType: 'text/plain',
      buffer: EVIDENCE_FILE.bytes,
    });
    expect((await uploaded).status()).toBe(201);
    await expect(card.getByText(sha256(EVIDENCE_FILE.bytes)).first()).toBeVisible();

    // Link it to the linked requirement's first objective, so the SSP lists it there.
    await client.write(
      'PUT',
      `/api/evidence/${item.id}/objectives`,
      { objectiveIds: [firstObjectiveId(linkedRequirement)] },
      evidenceItemResponseSchema,
    );

    await form.getByLabel('Title').fill(cuiTitle);
    await form.getByText('Contains CUI', { exact: true }).click();
    await expect(form.getByRole('checkbox', { name: 'Contains CUI' })).toBeChecked();
    const cuiCreated = answer(page, 'POST', '/api/evidence');
    await form.getByRole('button', { name: 'Create evidence item' }).click();
    const cuiItem = evidenceItemResponseSchema.parse(await (await cuiCreated).json()).item;
    expect(cuiItem.containsCui).toBe(true);
    cuiEvidenceId = cuiItem.id;
    const cuiCard = page.getByRole('listitem').filter({
      has: page.getByRole('heading', { name: cuiTitle, exact: true }),
    });
    await cuiCard.getByRole('button', { name: `Details for ${cuiTitle}` }).click();
    await expect(cuiCard.getByLabel('Where the file lives')).toBeVisible();
    await expect(cuiCard.getByLabel('Upload a file')).toHaveCount(0);

    const refused = await client.upload(
      `/api/evidence/${cuiItem.id}/versions`,
      EVIDENCE_FILE.name,
      EVIDENCE_FILE.bytes,
    );
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'cui_file_refused' } });

    const location = CUI_LOCATION;
    await cuiCard.getByLabel('Where the file lives').fill(location);
    const recorded = answer(page, 'POST', `/api/evidence/${cuiItem.id}/references`);
    await cuiCard.getByRole('button', { name: 'Record where it lives' }).click();
    expect((await recorded).status()).toBe(201);

    // Saved data counts after a reload.
    const reloaded = answer(page, 'GET', '/api/evidence');
    await page.reload();
    await reloaded;
    await expect(card.getByText(sha256(EVIDENCE_FILE.bytes))).toBeVisible();
    await expect(cuiCard.getByText(location)).toBeVisible();
  });

  test('policy upload and link', async () => {
    const loaded = answer(page, 'GET', '/api/policies');
    await page.goto('/policies');
    await loaded;
    const form = page.getByRole('form', { name: 'Add a policy' });
    await form.getByLabel('Title').fill(policyTitle);
    const created = answer(page, 'POST', '/api/policies');
    await form.getByRole('button', { name: 'Add policy' }).click();
    expect((await created).status()).toBe(201);

    const item = page.getByRole('listitem', { name: policyTitle, exact: true });
    const uploaded = answer(page, 'POST', /^\/api\/policies\/[^/]+\/versions$/);
    await item.getByLabel('Upload a new version').setInputFiles({
      name: POLICY_FILE.name,
      mimeType: 'text/markdown',
      buffer: POLICY_FILE.bytes,
    });
    expect((await uploaded).status()).toBe(201);

    const links = item.getByRole('form', { name: 'Requirement links' });
    await links.getByText(linkedRequirement.id, { exact: true }).click();
    const linked = answer(page, 'PUT', /^\/api\/policies\/[^/]+\/requirements$/);
    await links.getByRole('button', { name: 'Save links' }).click();
    expect((await linked).ok()).toBe(true);

    const reloaded = answer(page, 'GET', '/api/policies');
    await page.reload();
    await reloaded;
    await expect(item.getByText(sha256(POLICY_FILE.bytes))).toBeVisible();
    await expect(item.getByText(POLICY_FILE.name)).toBeVisible();
    await expect(item.getByText('1 requirement linked')).toBeVisible();
    await expect(
      item.getByRole('checkbox', { name: linkedRequirement.id, exact: true }),
    ).toBeChecked();

    const stored = await client.read('/api/policies', policyListSchema);
    expect(stored.items).toEqual([
      expect.objectContaining({ title: policyTitle, requirementIds: [linkedRequirement.id] }),
    ]);
  });

  test('SSP export contents', async () => {
    test.setTimeout(120_000);
    const loaded = answer(page, 'GET', '/api/system-profile');
    await page.goto('/ssp');
    await loaded;
    for (const { key, label } of SYSTEM_PROFILE_FIELDS) {
      await page.getByLabel(label, { exact: true }).fill(PROFILE[key]);
    }
    const saved = answer(page, 'PATCH', '/api/system-profile');
    await page.getByRole('button', { name: 'Save profile' }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

    const reloaded = answer(page, 'GET', '/api/system-profile');
    await page.reload();
    await reloaded;
    for (const { key, label } of SYSTEM_PROFILE_FIELDS) {
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(PROFILE[key]);
    }
    await expect(page.getByText(`by ${ADMIN.displayName}`)).toBeVisible();

    await inBatches(catalog.requirements, async (r) => {
      await client.write(
        'PATCH',
        `/api/assessment/requirements/${r.id}`,
        { implementationStatement: statementFor(r) },
        requirementWriteResponseSchema,
      );
    });
    const view = await readView(client);
    // Readiness and the export link live on the SSP workspace's Lint & export tab.
    await page.goto('/ssp?tab=export');
    await expect(
      page.getByText(
        `${String(catalog.requirements.length)} of ${String(catalog.requirements.length)} requirements have an implementation statement`,
      ),
    ).toBeVisible();

    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export SSP (.docx)' }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(
      sspFileName(PROFILE.systemIdentifier, new Date().toISOString().slice(0, 10)),
    );
    const bytes = await readFile(await download.path());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    const lines = docxText(bytes).split('\n');

    for (const { key, label } of SYSTEM_PROFILE_FIELDS) {
      const at = lines.indexOf(label);
      expect(at, `profile label ${label}`).toBeGreaterThanOrEqual(0);
      expect(lines[at + 1], `profile value for ${label}`).toBe(PROFILE[key]);
    }
    expectEveryRequirement(lines, view);

    const linkedSection = sectionOf(lines, linkedRequirement.id);
    expect(linkedSection).toContain(policyTitle);
    expect(linkedSection).toContain(evidenceTitle);
  });

  test('SSP workspace data', async () => {
    test.setTimeout(120_000);
    // One role through Identification & roles, privileged, kept after a reload.
    const loaded = answer(page, 'GET', '/api/ssp/roles');
    await page.goto('/ssp?tab=identification');
    await loaded;
    const form = page.getByRole('form', { name: 'Add role' });
    await form.getByLabel('Title', { exact: true }).fill(ROLE.title);
    await form.getByLabel('Person', { exact: true }).fill(ROLE.person);
    await form.getByLabel('Responsibilities', { exact: true }).fill(ROLE.responsibilities);
    await form.getByLabel('Number of users', { exact: true }).fill(String(ROLE.userCount));
    await form.getByText('Privileged', { exact: true }).click();
    await expect(form.getByRole('checkbox', { name: 'Privileged' })).toBeChecked();
    const created = answer(page, 'POST', '/api/ssp/roles');
    await form.getByRole('button', { name: 'Add role' }).click();
    expect((await created).ok()).toBe(true);
    const reloaded = answer(page, 'GET', '/api/ssp/roles');
    await page.reload();
    await reloaded;
    const roles = page.getByRole('table', { name: 'System roles' });
    await expect(roles.getByRole('row', { name: new RegExp(ROLE.title) })).toContainText('Yes');
    await expect(
      page.getByText(`${String(ROLE.userCount)} users · ${String(ROLE.userCount)} privileged`),
    ).toBeVisible();

    // The rest through the api, as the same admin.
    await client.write('PATCH', '/api/ssp/profile', SSP_PROFILE, sspProfileResponseSchema);
    for (const asset of ASSETS) {
      await client.write(
        'POST',
        '/api/ssp/assets',
        { owner: 'Ira IT', location: 'Server room', treatment: null, ...asset },
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
        services: 'Hosted email for the enclave.',
        agreementReference: 'MSA-2026-014',
      },
      providerResponseSchema,
    );
    await client.write(
      'PUT',
      `/api/ssp/responsibilities/${encodeURIComponent(linkedRequirement.id)}`,
      { party: 'esp', providerId: provider.id, note: 'Northwind manages the accounts.' },
      responsibilityRowResponseSchema,
    );

    const png = await uploadEvidence(client, NETWORK_PNG);
    await linkDiagram(client, png.id, 'network', NETWORK_PNG.caption);
    const pdf = await uploadEvidence(client, OTHER_PDF);
    await linkDiagram(client, pdf.id, 'other', OTHER_PDF.caption);
    await linkDiagram(client, cuiEvidenceId, 'data_flow', CUI_CAPTION);

    await client.write('POST', '/api/ssp/approvals', APPROVAL, approvalResponseSchema);
    await client.write(
      'PATCH',
      `/api/assessment/requirements/${FUTURE_REQUIREMENT.id}`,
      { implementationStatement: FUTURE_STATEMENT },
      requirementWriteResponseSchema,
    );

    const { diagrams } = await client.read('/api/ssp/diagrams', diagramsResponseSchema);
    expect(diagrams.map((d) => [d.caption, d.embeddable])).toEqual([
      [NETWORK_PNG.caption, true],
      [CUI_CAPTION, false],
      [OTHER_PDF.caption, false],
    ]);
  });

  test('lint panel matches the api', async () => {
    const lint = await client.read('/api/ssp/lint', sspLintResponseSchema);
    // The run's two seeded findings, one per severity, worded as the rules say.
    expect(lint.findings).toContainEqual(
      expect.objectContaining({
        rule: 'review_overdue',
        severity: 'error',
        message: `The SSP review was due ${SSP_PROFILE.nextReviewDate}, ${String(REVIEW_OVERDUE_DAYS)} days ago.`,
      }),
    );
    expect(lint.findings).toContainEqual(
      expect.objectContaining({
        rule: 'future_tense',
        severity: 'warning',
        requirementId: FUTURE_REQUIREMENT.id,
        message: `${FUTURE_REQUIREMENT.id} says "will", "TBD" (future tense).`,
      }),
    );
    const before = await client.read('/api/ssp/document-control', documentControlSchema);

    const loaded = Promise.all(
      ['/api/assessment', '/api/ssp/assets', '/api/ssp/diagrams', '/api/ssp/document-control'].map(
        (path) => answer(page, 'GET', path),
      ),
    );
    await page.goto('/ssp?tab=export');
    await loaded;
    await expect(page.getByText(summaryOf(lint.counts), { exact: true })).toBeVisible();

    // One group per rule that fired, in rule order, each with its first ten messages.
    const byRule = new Map<string, SspLintResponse['findings']>();
    for (const finding of lint.findings) {
      byRule.set(finding.rule, [...(byRule.get(finding.rule) ?? []), finding]);
    }
    const rules = SSP_LINT_RULES.filter((rule) => byRule.has(rule.id));
    const groups = page.locator('[data-tone]:has([data-message])');
    await expect(groups.locator('> p:first-child')).toHaveText(
      rules.map((rule) => `${rule.label} · ${String(byRule.get(rule.id)?.length ?? 0)}`),
    );
    for (const [index, rule] of rules.entries()) {
      const group = groups.nth(index);
      const findings = byRule.get(rule.id) ?? [];
      await expect(group).toHaveAttribute(
        'data-tone',
        rule.severity === 'error' ? 'error' : 'info',
      );
      await expect(group.locator('[data-message]')).toHaveText(
        findings.slice(0, 10).map((f) => f.message),
      );
      for (const finding of findings.slice(0, 10)) {
        if (finding.requirementId === null) continue;
        const family = requirementById(catalog, finding.requirementId).family;
        await expect(
          group.getByRole('link', { name: `Open ${finding.requirementId}`, exact: true }),
        ).toHaveAttribute('href', `/assessment?family=${family}&req=${finding.requirementId}`);
      }
    }

    // The check reads only: neither the api's lint nor the panel wrote a revision.
    const after = await client.read('/api/ssp/document-control', documentControlSchema);
    expect(after.revisions).toEqual(before.revisions);
  });

  test('SSP v2 export', async () => {
    test.setTimeout(120_000);
    const before = await client.read('/api/ssp/document-control', documentControlSchema);
    const { diagrams } = await client.read('/api/ssp/diagrams', diagramsResponseSchema);
    const view = await readView(client);
    const today = new Date().toISOString().slice(0, 10);
    const fileName = sspFileName(PROFILE.systemIdentifier, today);

    const loaded = answer(page, 'GET', '/api/assessment');
    await page.goto('/ssp?tab=export');
    await loaded;
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export SSP (.docx)' }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(fileName);
    const bytes = await readFile(await download.path());
    const xml = docxPart(bytes);
    const lines = docxText(bytes).split('\n');

    expect(headingsOf(xml, 1)).toEqual(SSP_HEADINGS);

    // 1.1: the role added in the UI, its row in table order, and the totals under it.
    const roles = linesBetween(lines, '1.1 Roles and users', '2. System environment');
    const row = roles.indexOf(ROLE.title);
    expect(row, 'the UI role in 1.1').toBeGreaterThanOrEqual(0);
    expect(roles.slice(row, row + 5)).toEqual([
      ROLE.title,
      ROLE.person,
      ROLE.responsibilities,
      String(ROLE.userCount),
      'Yes',
    ]);
    expect(roles).toContain(`Number of users: ${String(ROLE.userCount)}`);
    expect(roles).toContain(`Privileged and administrative users: ${String(ROLE.userCount)}`);

    // 2.1: the PNG embedded, the PDF and the CUI item as references, nothing else in media.
    expect(docxMedia(bytes)).toHaveLength(1);
    expect(docxMedia(bytes)[0]).toMatch(/\.png$/);
    expect(xml.match(/<w:drawing>/g) ?? []).toHaveLength(1);
    const linkFor = (caption: string): DiagramLink => {
      const link = diagrams.find((d) => d.caption === caption);
      if (link?.resolved == null) throw new Error(`${caption} has no resolved version`);
      return link;
    };
    const dayOf = (link: DiagramLink) =>
      new Date(link.resolved?.createdAt ?? '').toISOString().slice(0, 10);
    const png = linkFor(NETWORK_PNG.caption);
    const pdf = linkFor(OTHER_PDF.caption);
    const cui = linkFor(CUI_CAPTION);
    const figures = linesBetween(lines, '2.1 Diagrams', 'CMMC: CUI description');
    expect(figures).toContain(
      `Figure 1. ${NETWORK_PNG.caption} — Network diagram, ${NETWORK_PNG.title} v1, ` +
        `${NETWORK_PNG.fileName}, SHA-256 ${sha256(NETWORK_PNG.bytes)}, ${dayOf(png)}`,
    );
    expect(figures).toContain(
      `${OTHER_PDF.caption} — Other diagram: ${OTHER_PDF.title} v1, ${OTHER_PDF.fileName}, ` +
        `SHA-256 ${sha256(OTHER_PDF.bytes)}, ${dayOf(pdf)}`,
    );
    expect(figures).toContain(
      `${CUI_CAPTION} — CUI data flow: ${cuiTitle} v1, contains CUI, kept at ` +
        `${CUI_LOCATION}, ${dayOf(cui)}`,
    );

    // 4: the stored revisions, then this export's own entry, which the api then stored last.
    const changes = linesBetween(lines, '4. Record of changes', 'Approvals');
    const ownEntry = [today, `Exported as ${fileName}`, ADMIN.displayName];
    expect(changes.slice(-3)).toEqual(ownEntry);
    const after = await client.read('/api/ssp/document-control', documentControlSchema);
    expect(after.revisions).toHaveLength(before.revisions.length + 1);
    expect(after.revisions.slice(0, -1)).toEqual(before.revisions);
    expect(after.revisions.at(-1)).toMatchObject({
      kind: 'export',
      date: ownEntry[0],
      description: ownEntry[1],
      madeBy: ownEntry[2],
    });

    // Approvals: the signature block, its date filled in.
    expect(linesBetween(lines, 'Approvals', SSP_HEADINGS[8] ?? '')).toEqual([
      `${APPROVAL.name}, ${APPROVAL.title}`,
      `Signature: ${'_'.repeat(32)}`,
      `Date: ${APPROVAL.approvedOn}`,
    ]);

    // Appendix A's SPRS line, and an Appendix B objective row.
    const score = view.evaluation.score;
    expect(score.kind).toBe('scored');
    if (score.kind === 'scored') {
      expect(linesBetween(lines, SSP_HEADINGS[8] ?? '', SSP_HEADINGS[9] ?? '')).toContain(
        `SPRS ${String(score.score)} / ${String(score.max)}`,
      );
    }
    const objective = BARRED.objectives[0];
    const appendixB = lines.slice(lines.indexOf(SSP_HEADINGS[9] ?? ''));
    const at = appendixB.indexOf(objective?.id ?? '');
    expect(at, 'an Appendix B objective row').toBeGreaterThan(0);
    expect(appendixB.slice(at, at + 3)).toEqual([objective?.id, objective?.text, 'Met']);
  });

  test('audit trail', async () => {
    const events = async (entityType: string) =>
      (await client.read(`/api/audit?entityType=${entityType}&limit=200`, auditPageSchema)).events;
    const finishedAt = new Date();

    const expectStamped = (event: AuditEvent | undefined, kind: 'created' | 'changed') => {
      expect(event, 'event recorded').toBeDefined();
      if (event === undefined) return;
      expect(event.actor?.id).toBe(adminId);
      const at = new Date(event.at).getTime();
      expect(at).toBeGreaterThanOrEqual(startedAt.getTime() - 1000);
      expect(at).toBeLessThanOrEqual(finishedAt.getTime() + 1000);
      expect(event.after).not.toBeNull();
      if (kind === 'changed') expect(event.before).not.toBeNull();
      else expect(event.before).toBeNull();
    };

    // The UI changes to 3.1.20: Met to Not Met, then back.
    const barredObjective = firstObjectiveId(BARRED);
    const objectiveEvents = (await events('objective_result')).filter(
      (e) => e.entityId === barredObjective,
    );
    const toNotMet = objectiveEvents.find(
      (e) => (e.after as { status?: string } | null)?.status === 'not_met',
    );
    expectStamped(toNotMet, 'changed');
    expect(toNotMet?.before).toEqual({ status: 'met' });

    // The statements set in bulk, then one rewritten in the future tense.
    const statements = (await events('requirement_state')).filter(
      (e) => e.action === 'requirement_state.updated',
    );
    const saysFuture = (e: AuditEvent) =>
      (e.after as { implementationStatement?: string } | null)?.implementationStatement ===
      FUTURE_STATEMENT;
    expectStamped(
      statements.find((e) => !saysFuture(e)),
      'created',
    );
    expectStamped(statements.find(saysFuture), 'changed');

    const poam = (await events('poam_item')).filter((e) => e.action === 'poam_item.created');
    expect(poam).toHaveLength(POAM_COUNT);
    for (const event of poam) expectStamped(event, 'created');

    const evidence = await events('evidence_item');
    expectStamped(
      evidence.find((e) => e.action === 'evidence.created'),
      'created',
    );
    expectStamped(
      evidence.find((e) => e.action === 'evidence.version_added'),
      'created',
    );
    expectStamped(
      evidence.find((e) => e.action === 'evidence.links_updated'),
      'changed',
    );

    const policies = await events('policy');
    expectStamped(
      policies.find((e) => e.action === 'policy.created'),
      'created',
    );
    expectStamped(
      policies.find((e) => e.action === 'policy.version_added'),
      'created',
    );
    expectStamped(
      policies.find((e) => e.action === 'policy.links_updated'),
      'changed',
    );

    const profile = (await events('system_profile')).find(
      (e) => e.action === 'system_profile.updated',
    );
    expectStamped(profile, 'created');
    expect(profile?.after).toMatchObject({ systemName: PROFILE.systemName });
  });
});

/** Section 3's lines: from "3. Requirements" up to "4. Record of changes". */
function requirementsSection(lines: readonly string[]): readonly string[] {
  const start = lines.indexOf('3. Requirements');
  const end = lines.indexOf('4. Record of changes');
  expect(start, 'section 3 heading').toBeGreaterThanOrEqual(0);
  expect(end, 'section 4 after section 3').toBeGreaterThan(start);
  return lines.slice(start, end);
}

/**
 * The lines from a requirement's heading (its ID alone on a line) up to the next one, inside
 * section 3: the matrix and the appendices list requirement IDs too.
 */
function sectionOf(lines: readonly string[], id: string): string[] {
  const ids = new Set(catalog.requirements.map((r) => r.id));
  const section = requirementsSection(lines);
  const start = section.indexOf(id);
  if (start < 0) return [];
  const end = section.findIndex((line, i) => i > start && ids.has(line));
  return section.slice(start, end < 0 ? undefined : end);
}

/** Each requirement appears with its NIST status (as the api derives it) and its statement. */
function expectEveryRequirement(lines: readonly string[], view: AssessmentView) {
  const outcomes = new Map(view.evaluation.outcomes.map((o) => [o.requirementId, o]));
  for (const requirement of catalog.requirements) {
    const section = sectionOf(lines, requirement.id);
    expect(section.length, `${requirement.id} has a section`).toBeGreaterThan(0);
    const outcome = outcomes.get(requirement.id);
    const label =
      NIST_STATUS_LABELS[
        outcome === undefined ? 'not_assessed' : nistImplementationStatus(outcome)
      ];
    expect(section, `${requirement.id} status`).toContain(`Status: ${label}`);
    const current = section.indexOf('Current implementation:');
    expect(current, `${requirement.id} current implementation`).toBeGreaterThanOrEqual(0);
    expect(section[current + 1], `${requirement.id} statement`).toBe(statementFor(requirement));
  }
}

/** The panel's summary for the api's counts: "1 error · 2 warnings", or the all-clear. */
function summaryOf({ errors, warnings }: SspLintResponse['counts']): string {
  if (errors + warnings === 0) return 'No findings. Every check passes.';
  const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
  return `${count(errors, 'error')} \u00b7 ${count(warnings, 'warning')}`;
}

/** The lines after the line `start` and before the next line `end`. */
function linesBetween(lines: readonly string[], start: string, end: string): string[] {
  const from = lines.indexOf(start);
  const to = lines.indexOf(end, from + 1);
  expect(from, `"${start}" in the document`).toBeGreaterThanOrEqual(0);
  expect(to, `"${end}" after "${start}"`).toBeGreaterThan(from);
  return lines.slice(from + 1, to);
}

/** The text of every paragraph styled as a heading of `level`, in document order. */
function headingsOf(xml: string, level: 1 | 2 | 3): string[] {
  const style = `<w:pStyle w:val="Heading${String(level)}"/>`;
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .filter(([, body]) => body?.includes(style))
    .map(([, body]) =>
      [...(body ?? '').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''),
    );
}
