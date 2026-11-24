import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { requirementState } from '../../db/schema';
import {
  assessmentViewSchema,
  auditPageSchema,
  errorEnvelopeSchema,
  requirementWriteResponseSchema,
  userResponseSchema,
  type AuditPage,
  type RequirementWriteResponse,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const CONTRIBUTOR = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'a long enough password',
};

const ENCRYPTION = 'SC.L2-3.13.11';
const PASSWORD = 'IA.L2-3.5.3';

async function world(): Promise<{ h: Harness; admin: Client; carlId: string }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  const created = userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
  return { h, admin, carlId: created.user.id };
}

const url = (id: string) => `/api/assessment/requirements/${encodeURIComponent(id)}`;
const objectiveUrl = (id: string) => `/api/assessment/objectives/${encodeURIComponent(id)}`;

function code(body: string): string {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error.code;
}

async function patch(client: Client, id: string, body: unknown): Promise<RequirementWriteResponse> {
  const response = await client.patch(url(id), body);
  expect(response.statusCode, response.body).toBe(200);
  return requirementWriteResponseSchema.parse(response.json());
}

function deduction(body: RequirementWriteResponse, id: string): number | undefined {
  return body.evaluation.outcomes.find((o) => o.requirementId === id)?.deduction;
}

async function requirementEvents(client: Client, id: string): Promise<AuditPage['events']> {
  const response = await client.get(
    `/api/audit?entityType=requirement_state&entityId=${encodeURIComponent(id)}`,
  );
  return auditPageSchema.parse(response.json()).events;
}

describe('requirement state', () => {
  it('gives 400 for a level on a requirement without partial credit, even null', async () => {
    const { h, admin } = await world();
    for (const implementationLevel of ['partial', 'none', null]) {
      const response = await admin.patch(url('AC.L2-3.1.1'), { implementationLevel });
      expect(response.statusCode, String(implementationLevel)).toBe(400);
      expect(code(response.body)).toBe('validation_failed');
    }
    // CA.L2-3.12.4 is the prerequisite: no points, so no partial credit either.
    expect(
      (await admin.patch(url('CA.L2-3.12.4'), { implementationLevel: 'partial' })).statusCode,
    ).toBe(400);
    const bad = await admin.patch(url(ENCRYPTION), { implementationLevel: 'Partial' });
    expect(bad.statusCode).toBe(400);
    expect(h.db.select().from(requirementState).all()).toEqual([]);
  });

  it('moves 3.13.11 not_met from −5 to −3 at partial, and null unsets it', async () => {
    const { admin } = await world();
    const marked = await admin.put(objectiveUrl('3.13.11[a]'), { status: 'not_met', note: null });
    expect(marked.statusCode).toBe(200);

    const partial = await patch(admin, ENCRYPTION, { implementationLevel: 'partial' });
    expect(partial.requirementState.implementationLevel).toBe('partial');
    expect(deduction(partial, ENCRYPTION)).toBe(3);

    const none = await patch(admin, ENCRYPTION, { implementationLevel: 'none' });
    expect(deduction(none, ENCRYPTION)).toBe(5);

    await patch(admin, ENCRYPTION, { implementationLevel: 'partial' });
    const unset = await patch(admin, ENCRYPTION, { implementationLevel: null });
    expect(unset.requirementState.implementationLevel).toBeNull();
    expect(deduction(unset, ENCRYPTION)).toBe(5);

    // 3.5.3 is the other partial-credit requirement.
    expect(
      (await patch(admin, PASSWORD, { implementationLevel: 'partial' })).requirementState,
    ).toMatchObject({ requirementId: PASSWORD, implementationLevel: 'partial' });

    const view = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    expect(view.requirementStates.map((s) => [s.requirementId, s.implementationLevel])).toEqual([
      [PASSWORD, 'partial'],
      [ENCRYPTION, null],
    ]);
  });

  it('assigns an active owner, refuses an unknown or inactive one, and null unassigns', async () => {
    const { admin, carlId } = await world();
    const assigned = await patch(admin, 'AC.L2-3.1.1', { ownerId: carlId });
    expect(assigned.requirementState.owner).toEqual({
      id: carlId,
      displayName: CONTRIBUTOR.displayName,
      active: true,
    });

    for (const ownerId of [randomUUID(), 'not-a-uuid']) {
      const response = await admin.patch(url('AC.L2-3.1.2'), { ownerId });
      expect(response.statusCode, ownerId).toBe(400);
      expect(code(response.body)).toBe('validation_failed');
    }

    // Deactivated later: still assigned, shown inactive.
    expect((await admin.patch(`/api/users/${carlId}`, { active: false })).statusCode).toBe(200);
    const view = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    expect(view.requirementStates[0]?.owner).toEqual({
      id: carlId,
      displayName: CONTRIBUTOR.displayName,
      active: false,
    });
    const other = await patch(admin, 'AC.L2-3.1.1', { implementationStatement: 'Still Carl' });
    expect(other.requirementState.owner).toMatchObject({ id: carlId, active: false });

    // An inactive user can't be newly assigned.
    const inactive = await admin.patch(url('AC.L2-3.1.2'), { ownerId: carlId });
    expect(inactive.statusCode).toBe(400);
    expect(code(inactive.body)).toBe('validation_failed');

    const unassigned = await patch(admin, 'AC.L2-3.1.1', { ownerId: null });
    expect(unassigned.requirementState.owner).toBeNull();
  });

  it('gives 404 for an unknown requirement', async () => {
    const { admin } = await world();
    await patch(admin, 'AC.L2-3.1.1', { implementationStatement: 'x' });
    for (const id of ['AC.L2-3.1.99', '3.1.1', '3.1.1[a]', 'ac.l2-3.1.1']) {
      const response = await admin.patch(url(id), { implementationStatement: 'x' });
      expect(response.statusCode, id).toBe(404);
      expect(code(response.body)).toBe('not_found');
    }
  });

  it('audits only the changed fields; a create has before null; a repeat writes nothing', async () => {
    const { h, admin, carlId } = await world();
    await patch(admin, 'AC.L2-3.1.1', { implementationStatement: '  We use SSO.  ' });
    let events = await requirementEvents(admin, 'AC.L2-3.1.1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'requirement_state.updated',
      entityType: 'requirement_state',
      entityId: 'AC.L2-3.1.1',
      before: null,
      after: { implementationStatement: 'We use SSO.' },
    });

    h.clock.advance(60_000);
    const first = await patch(admin, 'AC.L2-3.1.1', { ownerId: carlId });
    events = await requirementEvents(admin, 'AC.L2-3.1.1');
    expect(events[0]).toMatchObject({ before: { ownerId: null }, after: { ownerId: carlId } });
    expect(first.requirementState.updatedAt).toBe(h.clock.now().toISOString());

    h.clock.advance(60_000);
    const again = await patch(admin, 'AC.L2-3.1.1', {
      ownerId: carlId,
      implementationStatement: 'We use SSO.',
    });
    expect(again.requirementState).toEqual(first.requirementState);
    expect(await requirementEvents(admin, 'AC.L2-3.1.1')).toHaveLength(2);

    // A blank statement on a requirement with no state changes nothing and stores nothing.
    const empty = await patch(admin, 'AC.L2-3.1.2', { implementationStatement: '   ' });
    expect(empty.requirementState).toMatchObject({
      requirementId: 'AC.L2-3.1.2',
      implementationStatement: null,
      implementationLevel: null,
      owner: null,
    });
    expect(await requirementEvents(admin, 'AC.L2-3.1.2')).toEqual([]);
    const view = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    expect(view.requirementStates.map((s) => s.requirementId)).toEqual(['AC.L2-3.1.1']);
  });
});

describe('limits and access', () => {
  it('gives 400 for a 20,001-character statement and takes 20,000', async () => {
    const { admin } = await world();
    const long = await admin.patch(url('AC.L2-3.1.1'), {
      implementationStatement: 'x'.repeat(20001),
    });
    expect(long.statusCode).toBe(400);
    expect(code(long.body)).toBe('validation_failed');
    const exact = await patch(admin, 'AC.L2-3.1.1', { implementationStatement: 'x'.repeat(20000) });
    expect(exact.requirementState.implementationStatement).toHaveLength(20000);
  });

  it('gives 400 for {} and unknown keys', async () => {
    const { admin } = await world();
    for (const body of [{}, { owner: null }, { implementationStatement: 'x', extra: true }]) {
      const response = await admin.patch(url('AC.L2-3.1.1'), body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(code(response.body)).toBe('validation_failed');
    }
    // Body comes before existence.
    expect((await admin.patch(url('AC.L2-3.1.99'), {})).statusCode).toBe(400);
  });

  it('lets a contributor write, and refuses a write with no CSRF header', async () => {
    const { h } = await world();
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
    const written = await patch(carl, ENCRYPTION, { implementationLevel: 'partial' });
    expect(written.requirementState.implementationLevel).toBe('partial');

    const noCsrf = await carl.patch(
      url(ENCRYPTION),
      { implementationLevel: null },
      { headers: { 'x-csrf-token': null } },
    );
    expect(noCsrf.statusCode).toBe(403);
    expect(code(noCsrf.body)).toBe('csrf_failed');
    const anon = await h.client().patch(url(ENCRYPTION), { implementationLevel: null });
    expect(anon.statusCode).toBe(401);

    const view = assessmentViewSchema.parse((await carl.get('/api/assessment')).json());
    expect(view.requirementStates[0]?.implementationLevel).toBe('partial');
  });
});
