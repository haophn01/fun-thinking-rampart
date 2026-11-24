import { loadCatalog, type RequirementId } from '@rampart/catalog';
import { REGULATION } from '@rampart/rules/poam';
import { afterEach, describe, expect, it } from 'vitest';
import { objectiveResult } from '../../db/schema';
import {
  assessmentViewSchema,
  auditPageSchema,
  errorEnvelopeSchema,
  objectiveWriteResponseSchema,
  type AuditPage,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const catalog = loadCatalog();
const CONTRIBUTOR = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'a long enough password',
};

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  return { h, admin };
}

const url = (id: string) => `/api/assessment/objectives/${encodeURIComponent(id)}`;

function code(body: string): string {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error.code;
}

async function objectiveEvents(client: Client, objectiveId: string): Promise<AuditPage['events']> {
  const query = `entityType=objective_result&entityId=${encodeURIComponent(objectiveId)}`;
  const response = await client.get(`/api/audit?${query}`);
  expect(response.statusCode).toBe(200);
  return auditPageSchema.parse(response.json()).events;
}

describe('validates objective writes', () => {
  it('accepts exactly met, not_met, na and not_assessed', async () => {
    const { admin } = await world();
    for (const status of ['met', 'not_met', 'na', 'not_assessed']) {
      const response = await admin.put(url('3.1.1[a]'), { status, note: null });
      expect(response.statusCode, status).toBe(200);
      const body = objectiveWriteResponseSchema.parse(response.json());
      expect(body.objectiveResult.status).toBe(status);
    }
  });

  it("rejects 'Met', 'unknown', '', null and a missing status with 400 and stores nothing", async () => {
    const { h, admin } = await world();
    const bodies: [string, unknown][] = [
      ["'Met'", { status: 'Met', note: null }],
      ["'NOT_MET'", { status: 'NOT_MET', note: null }],
      ["'unknown'", { status: 'unknown', note: null }],
      ["''", { status: '', note: null }],
      ['null', { status: null, note: null }],
      ['missing', { note: null }],
      ['missing note', { status: 'met' }],
      ['unknown key', { status: 'met', note: null, extra: 1 }],
      ['note over 4,000', { status: 'met', note: 'x'.repeat(4001) }],
    ];
    for (const [label, body] of bodies) {
      const response = await admin.put(url('3.1.1[a]'), body);
      expect(response.statusCode, label).toBe(400);
      expect(code(response.body), label).toBe('validation_failed');
    }
    expect(h.db.select().from(objectiveResult).all()).toEqual([]);
  });

  it('gives 404 for an unknown objective, after the body check', async () => {
    const { admin } = await world();
    for (const id of ['3.1.1[z]', '3.1.99[a]', 'AC.L2-3.1.1', '3.1.1']) {
      const response = await admin.put(url(id), { status: 'met', note: null });
      expect(response.statusCode, id).toBe(404);
      expect(code(response.body), id).toBe('not_found');
    }
    // A bad body on an unknown objective is still a 400: body comes before existence.
    const bad = await admin.put(url('3.1.1[z]'), { status: 'Met', note: null });
    expect(bad.statusCode).toBe(400);
  });

  it('takes the URL-encoded ID 3.1.1%5Ba%5D', async () => {
    const { admin } = await world();
    const response = await admin.put('/api/assessment/objectives/3.1.1%5Ba%5D', {
      status: 'met',
      note: null,
    });
    expect(response.statusCode).toBe(200);
    expect(objectiveWriteResponseSchema.parse(response.json()).objectiveResult.objectiveId).toBe(
      '3.1.1[a]',
    );
    const view = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    expect(view.objectiveResults.map((r) => r.objectiveId)).toEqual(['3.1.1[a]']);
  });

  it('lets a contributor write, and needs a session and the CSRF token', async () => {
    const { h, admin } = await world();
    await admin.post('/api/users', CONTRIBUTOR);
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);

    const written = await carl.put(url('3.1.1[a]'), { status: 'met', note: null });
    expect(written.statusCode).toBe(200);
    expect(objectiveWriteResponseSchema.parse(written.json()).objectiveResult.updatedBy).toEqual({
      id: carl.user?.id,
      displayName: CONTRIBUTOR.displayName,
    });

    const noCsrf = await carl.put(
      url('3.1.1[b]'),
      { status: 'met', note: null },
      {
        headers: { 'x-csrf-token': null },
      },
    );
    expect(noCsrf.statusCode).toBe(403);
    expect(code(noCsrf.body)).toBe('csrf_failed');

    const anon = await h.client().put(url('3.1.1[b]'), { status: 'met', note: null });
    expect(anon.statusCode).toBe(401);
  });
});

describe('audit and repeats', () => {
  it('audits a first write with before null and a change with only the changed fields', async () => {
    const { h, admin } = await world();
    const first = await admin.put(url('3.1.1[a]'), { status: 'not_met', note: 'No MFA yet' });
    expect(first.statusCode).toBe(200);

    let events = await objectiveEvents(admin, '3.1.1[a]');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'objective_result.updated',
      entityType: 'objective_result',
      entityId: '3.1.1[a]',
      actor: { id: admin.user?.id, displayName: 'Ada Admin' },
      before: null,
      after: { status: 'not_met', note: 'No MFA yet' },
      at: h.clock.now().toISOString(),
    });

    h.clock.advance(60_000);
    await admin.put(url('3.1.1[a]'), { status: 'met', note: 'No MFA yet' });
    events = await objectiveEvents(admin, '3.1.1[a]');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ before: { status: 'not_met' }, after: { status: 'met' } });

    await admin.put(url('3.1.1[a]'), { status: 'met', note: 'MFA on' });
    events = await objectiveEvents(admin, '3.1.1[a]');
    expect(events[0]).toMatchObject({ before: { note: 'No MFA yet' }, after: { note: 'MFA on' } });
  });

  it('gives 200 with no event and leaves the row alone on an identical repeat', async () => {
    const { h, admin } = await world();
    const first = objectiveWriteResponseSchema.parse(
      (await admin.put(url('3.1.1[a]'), { status: 'met', note: 'Done' })).json(),
    );
    h.clock.advance(60_000);
    const again = await admin.put(url('3.1.1[a]'), { status: 'met', note: '  Done  ' });
    expect(again.statusCode).toBe(200);
    const body = objectiveWriteResponseSchema.parse(again.json());
    expect(body.objectiveResult).toEqual(first.objectiveResult);
    expect(body.evaluation).toEqual(first.evaluation);
    expect(await objectiveEvents(admin, '3.1.1[a]')).toHaveLength(1);
  });

  it('trims the note and stores blank as null', async () => {
    const { h, admin } = await world();
    const trimmed = objectiveWriteResponseSchema.parse(
      (await admin.put(url('3.1.1[a]'), { status: 'met', note: '  Reviewed  ' })).json(),
    );
    expect(trimmed.objectiveResult.note).toBe('Reviewed');

    const blank = objectiveWriteResponseSchema.parse(
      (await admin.put(url('3.1.1[a]'), { status: 'met', note: '   \n ' })).json(),
    );
    expect(blank.objectiveResult.note).toBeNull();
    const stored = h.db.select().from(objectiveResult).all();
    expect(stored.map((r) => r.note)).toEqual([null]);
    expect((await objectiveEvents(admin, '3.1.1[a]'))[0]).toMatchObject({
      before: { note: 'Reviewed' },
      after: { note: null },
    });

    const exactly = await admin.put(url('3.1.1[a]'), { status: 'met', note: 'y'.repeat(4000) });
    expect(exactly.statusCode).toBe(200);
  });
});

describe('main flow 72 with 3.1.20', () => {
  it('returns score 72, not_eligible, below_threshold and poam_ineligible(AC.L2-3.1.20, barred)', async () => {
    const { admin } = await world();
    const barred = new Set(REGULATION.poamBarred.value);
    const points = (n: number) =>
      catalog.requirements
        .filter((r) => r.scoring.kind === 'points' && r.scoring.points === n)
        .map((r) => r.id);
    // 3.1.20 costs 1; 7 five-point requirements cost 35; two more one-pointers bring it to 38.
    const failing = new Set<RequirementId>([
      'AC.L2-3.1.20',
      ...points(5).slice(0, 7),
      ...points(1)
        .filter((id) => !barred.has(id))
        .slice(0, 2),
    ]);

    let last: unknown;
    for (const requirement of catalog.requirements) {
      for (const { id } of requirement.objectives) {
        const status = failing.has(requirement.id) ? 'not_met' : 'met';
        const response = await admin.put(url(id), { status, note: null });
        expect(response.statusCode, id).toBe(200);
        last = response.json();
      }
    }

    const { evaluation } = objectiveWriteResponseSchema.parse(last);
    expect(evaluation.score).toMatchObject({ kind: 'scored', score: 72 });
    expect(evaluation.conditional.status).toBe('not_eligible');
    expect(evaluation.conditional.blockers).toContainEqual({
      code: 'below_threshold',
      score: 72,
      threshold: 88,
      citation: REGULATION.conditionalMinScore.citation,
    });
    expect(evaluation.conditional.blockers).toContainEqual({
      code: 'poam_ineligible',
      requirementId: 'AC.L2-3.1.20',
      reasons: ['barred'],
      citation: REGULATION.poamBarred.citation,
    });

    const view = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    expect(view.evaluation).toEqual(evaluation);
    expect(view.objectiveResults).toHaveLength(320);
  });
});

describe('change and audit are atomic', () => {
  it('gives 500 and keeps the stored result when the audit insert fails', async () => {
    const { h, admin } = await world();
    await admin.put(url('3.1.1[a]'), { status: 'met', note: 'Before' });
    const before = h.db.select().from(objectiveResult).all();

    h.handle.sqlite.exec(
      `CREATE TRIGGER test_audit_fails BEFORE INSERT ON audit_event
       BEGIN SELECT RAISE(ABORT, 'audit insert failed (test)'); END;`,
    );
    const change = await admin.put(url('3.1.1[a]'), { status: 'not_met', note: 'After' });
    expect(change.statusCode).toBe(500);
    expect(code(change.body)).toBe('internal_error');
    const created = await admin.put(url('3.1.1[b]'), { status: 'met', note: null });
    expect(created.statusCode).toBe(500);

    expect(h.db.select().from(objectiveResult).all()).toEqual(before);
    h.handle.sqlite.exec('DROP TRIGGER test_audit_fails');
    const view = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    expect(view.objectiveResults).toMatchObject([
      { objectiveId: '3.1.1[a]', status: 'met', note: 'Before' },
    ]);
  });
});
