import { loadCatalog } from '@rampart/catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { poamItemResponseSchema, poamViewSchema, type PoamItem, type PoamView } from '../contract';
import { ADMIN, createHarness, type Client, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const DAY = 86_400_000;
const ONE_POINT = 'AC.L2-3.1.3';
const OTHER_ONE_POINT = 'AC.L2-3.1.4';
const FIVE_POINT = 'AC.L2-3.1.1';
const BARRED = 'AC.L2-3.1.20';
const ENCRYPTION = 'SC.L2-3.13.11';

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  return { h, admin: await h.setupAdmin() };
}

/** Not Met marks one objective not_met; Met marks every objective met. */
async function mark(client: Client, requirementId: string, status: 'met' | 'not_met') {
  const requirement = loadCatalog().requirements.find((r) => r.id === requirementId);
  if (!requirement) throw new Error(`no ${requirementId}`);
  const objectives = status === 'met' ? requirement.objectives : requirement.objectives.slice(0, 1);
  for (const objective of objectives) {
    const response = await client.put(
      `/api/assessment/objectives/${encodeURIComponent(objective.id)}`,
      { status, note: null },
    );
    expect(response.statusCode, response.body).toBe(200);
  }
}

async function view(client: Client): Promise<PoamView> {
  const response = await client.get('/api/poam');
  expect(response.statusCode, response.body).toBe(200);
  return poamViewSchema.parse(response.json());
}

async function create(client: Client, body: Record<string, unknown>): Promise<PoamItem> {
  const response = await client.post('/api/poam', { plan: 'Fix it', ...body });
  expect(response.statusCode, response.body).toBe(201);
  return poamItemResponseSchema.parse(response.json()).item;
}

function itemFor(v: PoamView, requirementId: string): PoamItem {
  const item = v.items.find((i) => i.requirementId === requirementId && i.status === 'open');
  if (!item) throw new Error(`no open item for ${requirementId}`);
  return item;
}

async function setAssessment(client: Client, body: Record<string, unknown>) {
  const response = await client.patch('/api/assessment', body);
  expect(response.statusCode, response.body).toBe(200);
}

describe('GET /api/poam', () => {
  it('candidates and clock', async () => {
    const { admin } = await world();
    const empty = await view(admin);
    expect(empty).toEqual({ items: [], candidates: [], closeout: null, confirmer: 'organization' });

    for (const id of [BARRED, ONE_POINT, FIVE_POINT, OTHER_ONE_POINT])
      await mark(admin, id, 'not_met');
    await mark(admin, 'AC.L2-3.1.5', 'met');
    await create(admin, { requirementId: OTHER_ONE_POINT, due: '2026-12-31' });

    const v = await view(admin);
    expect(v.candidates).toEqual([
      {
        requirementId: FIVE_POINT,
        eligibility: {
          eligible: false,
          reasons: [{ code: 'exceeds_point_limit', citation: '32 CFR 170.21(a)(2)(ii)' }],
        },
      },
      { requirementId: ONE_POINT, eligibility: { eligible: true } },
      {
        requirementId: BARRED,
        eligibility: {
          eligible: false,
          reasons: [{ code: 'barred', citation: '32 CFR 170.21(a)(2)(iii)' }],
        },
      },
    ]);
    expect(v.items.map((i) => i.requirementId)).toEqual([OTHER_ONE_POINT]);
    expect(v.closeout).toBeNull();
    expect(v.confirmer).toBe('organization');

    await setAssessment(admin, { type: 'c3pao', conditionalStatusDate: '2026-11-01' });
    const c3pao = await view(admin);
    expect(c3pao.confirmer).toBe('c3pao');
    expect(c3pao.closeout).toEqual({
      conditionalStatusDate: '2026-11-01',
      deadline: '2027-04-30',
      daysRemaining: 158,
      expired: false,
    });
  });

  it('derived fields', async () => {
    const { h, admin } = await world();
    await mark(admin, ONE_POINT, 'not_met');
    await mark(admin, OTHER_ONE_POINT, 'not_met');
    // Today is 2026-11-23 (the harness start).
    await create(admin, { requirementId: ONE_POINT, due: '2026-11-24' });

    // Days apart, so each read signs in again: a session lasts 12 hours at most.
    const at = async (date: string) => {
      h.clock.set(new Date(`${date}T23:59:59.000Z`));
      return itemFor(await view(await h.signIn(ADMIN.email, ADMIN.password)), ONE_POINT);
    };
    expect(await at('2026-11-23')).toMatchObject({ daysToDue: 1, overdue: false });
    expect(await at('2026-11-24')).toMatchObject({ daysToDue: 0, overdue: false });
    expect(await at('2026-11-25')).toMatchObject({ daysToDue: -1, overdue: true });
    h.clock.set(new Date('2026-11-23T09:00:00.000Z'));

    // No CSD: no deadline, so nothing is due after it.
    expect(itemFor(await view(admin), ONE_POINT).dueAfterDeadline).toBe(false);

    // 2026-06-04 + 180 days = 2026-12-01.
    await setAssessment(admin, { conditionalStatusDate: '2026-06-04' });
    await admin.patch(`/api/poam/${itemFor(await view(admin), ONE_POINT).id}`, {
      due: '2026-12-01',
    });
    await create(admin, { requirementId: OTHER_ONE_POINT, due: '2026-12-02' });
    const withClock = await view(admin);
    expect(withClock.closeout?.deadline).toBe('2026-12-01');
    expect(itemFor(withClock, ONE_POINT).dueAfterDeadline).toBe(false);
    expect(itemFor(withClock, OTHER_ONE_POINT).dueAfterDeadline).toBe(true);

    // Ready to close only once the requirement is Met; it is then no longer eligible.
    expect(itemFor(withClock, ONE_POINT)).toMatchObject({
      requirementStatus: 'not_met',
      readyToClose: false,
      eligibility: { eligible: true },
    });
    await mark(admin, ONE_POINT, 'met');
    expect(itemFor(await view(admin), ONE_POINT)).toMatchObject({
      requirementStatus: 'met',
      readyToClose: true,
      eligibility: {
        eligible: false,
        reasons: [{ code: 'not_not_met', citation: '32 CFR 170.24(c)(2)(i)(B)(6)' }],
      },
    });

    // 3.13.11 is eligible at partial; its level moving to none or unset is seen on the next read.
    await mark(admin, ENCRYPTION, 'not_met');
    const level = (implementationLevel: string | null) =>
      admin.patch(`/api/assessment/requirements/${ENCRYPTION}`, { implementationLevel });
    expect((await level('partial')).statusCode).toBe(200);
    await create(admin, { requirementId: ENCRYPTION, due: '2026-11-30' });
    expect(itemFor(await view(admin), ENCRYPTION).eligibility).toEqual({ eligible: true });
    const ineligible = {
      eligible: false,
      reasons: [{ code: 'exceeds_point_limit', citation: '32 CFR 170.21(a)(2)(ii)' }],
    };
    for (const next of ['none', null]) {
      expect((await level(next)).statusCode).toBe(200);
      expect(itemFor(await view(admin), ENCRYPTION).eligibility, String(next)).toEqual(ineligible);
    }
  });

  it('orders open items by due then catalog order, then closed items newest closeout first', async () => {
    const { h, admin } = await world();
    const ids = ['AC.L2-3.1.6', 'AC.L2-3.1.7', ONE_POINT, OTHER_ONE_POINT];
    for (const id of ids) await mark(admin, id, 'not_met');
    await create(admin, { requirementId: 'AC.L2-3.1.7', due: '2026-12-10' });
    await create(admin, { requirementId: 'AC.L2-3.1.6', due: '2026-12-20' });
    await create(admin, { requirementId: OTHER_ONE_POINT, due: '2026-12-10' });
    const first = await create(admin, { requirementId: ONE_POINT, due: '2026-12-30' });

    h.clock.advance(3 * DAY);
    const signedIn = await h.signIn(ADMIN.email, ADMIN.password);
    const closeOut = async (item: PoamItem, closedOn: string) => {
      await mark(signedIn, item.requirementId, 'met');
      const response = await signedIn.post(`/api/poam/${item.id}/closeout`, {
        closedOn,
        note: null,
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    await closeOut(first, '2026-11-24');
    const v1 = await view(signedIn);
    await closeOut(itemFor(v1, 'AC.L2-3.1.6'), '2026-11-25');

    const v = await view(signedIn);
    expect(v.items.map((i) => [i.requirementId, i.status])).toEqual([
      [OTHER_ONE_POINT, 'open'],
      ['AC.L2-3.1.7', 'open'],
      ['AC.L2-3.1.6', 'closed'],
      [ONE_POINT, 'closed'],
    ]);
  });
});
