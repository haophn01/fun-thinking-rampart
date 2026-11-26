// The plan's Verification path, in the browser, against the run's fresh api and web app. Each
// named step goes through the UI; bulk writes go through the api as the same signed-in user.
// Scores are planned from the catalog and the regulation data, never from spelled-out points.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Response } from '@playwright/test';
import { loadCatalog, type Requirement } from '@rampart/catalog';
import { scoreMax } from '@rampart/rules';
import { REGULATION } from '@rampart/rules/poam';
import {
  NIST_STATUS_LABELS,
  PRODUCT_NAME,
  SYSTEM_PROFILE_FIELDS,
  assessmentViewSchema,
  auditPageSchema,
  evidenceItemResponseSchema,
  objectiveWriteResponseSchema,
  poamItemResponseSchema,
  policyListSchema,
  requirementWriteResponseSchema,
  sessionResponseSchema,
  sspFileName,
  type AssessmentView,
  type AuditEvent,
  nistImplementationStatus,
  type SystemProfileFieldKey,
} from '../apps/api/src/contract/index.ts';
import { api, type Api } from './helpers/api';
import { docxText } from './helpers/docx';
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
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

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

    const location = '\\\\enclave-fs01\\cui\\network-diagram.vsdx';
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

    const statements = await events('requirement_state');
    expectStamped(
      statements.find((e) => e.action === 'requirement_state.updated'),
      'created',
    );

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
