import { afterEach, describe, expect, it } from 'vitest';
import {
  assessmentViewSchema,
  auditPageSchema,
  errorEnvelopeSchema,
  type AssessmentView,
  type AuditPage,
} from '../contract';
import { ADMIN, createHarness, type Client, type Harness } from '../testing/harness';

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

async function world(start?: Date): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness(start === undefined ? {} : { start });
  harnesses.push(h);
  const admin = await h.setupAdmin();
  return { h, admin };
}

function code(body: string): string {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error.code;
}

async function save(admin: Client, body: unknown): Promise<AssessmentView> {
  const response = await admin.patch('/api/assessment', body);
  expect(response.statusCode, response.body).toBe(200);
  return assessmentViewSchema.parse(response.json());
}

async function assessmentEvents(admin: Client): Promise<AuditPage['events']> {
  const response = await admin.get('/api/audit?entityType=assessment');
  return auditPageSchema.parse(response.json()).events;
}

describe('assessment settings', () => {
  it('gives a contributor 403 and changes nothing', async () => {
    const { h, admin } = await world();
    await admin.post('/api/users', CONTRIBUTOR);
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
    const response = await carl.patch('/api/assessment', { type: 'c3pao' });
    expect(response.statusCode).toBe(403);
    expect(code(response.body)).toBe('forbidden');
    const view = assessmentViewSchema.parse((await carl.get('/api/assessment')).json());
    expect(view.assessment.type).toBe('self');
  });

  it('saves type c3pao, audits only the change and bumps updatedAt', async () => {
    const { h, admin } = await world();
    const before = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    h.clock.advance(60_000);
    const view = await save(admin, { type: 'c3pao' });
    expect(view.assessment.type).toBe('c3pao');
    expect(view.assessment.updatedAt).toBe(h.clock.now().toISOString());
    expect(view.evaluation).toEqual(before.evaluation);

    const events = await assessmentEvents(admin);
    expect(events[0]).toMatchObject({
      action: 'assessment.updated',
      entityType: 'assessment',
      entityId: before.assessment.id,
      actor: { id: admin.user?.id },
      before: { type: 'self' },
      after: { type: 'c3pao' },
    });

    // Saved: a fresh read sees it.
    const read = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    expect(read.assessment.type).toBe('c3pao');
  });

  it('refuses impossible dates, {} and unknown keys with 400', async () => {
    const { admin } = await world();
    const bodies: unknown[] = [
      { conditionalStatusDate: '2026-02-30' },
      { conditionalStatusDate: '2026-3-1' },
      { conditionalStatusDate: '03/01/2026' },
      { conditionalStatusDate: '' },
      { type: 'C3PAO' },
      { type: null },
      {},
      { catalogVersion: 'x' },
    ];
    for (const body of bodies) {
      const response = await admin.patch('/api/assessment', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(code(response.body)).toBe('validation_failed');
    }
    const view = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    expect(view.assessment).toMatchObject({ type: 'self', conditionalStatusDate: null });
    expect(await assessmentEvents(admin)).toHaveLength(1); // assessment.created only
  });

  it('gives deadline 2026-08-28 and 180 days for 2026-03-01 on 2026-03-01, and null clears it', async () => {
    const { h, admin } = await world(new Date('2026-03-01T23:59:00.000Z'));
    const view = await save(admin, { conditionalStatusDate: '2026-03-01' });
    expect(view.assessment.conditionalStatusDate).toBe('2026-03-01');
    expect(view.closeout).toEqual({
      conditionalStatusDate: '2026-03-01',
      deadline: '2026-08-28',
      daysRemaining: 180,
      expired: false,
    });

    // "Today" is the UTC date of the app clock, read on every request.
    // (Months later the old session has expired, so sign in again.)
    h.clock.set(new Date('2026-08-29T00:00:00.000Z'));
    const again = await h.signIn(ADMIN.email, ADMIN.password);
    const later = assessmentViewSchema.parse((await again.get('/api/assessment')).json());
    expect(later.closeout).toMatchObject({ daysRemaining: -1, expired: true });

    const cleared = await save(again, { conditionalStatusDate: null });
    expect(cleared.assessment.conditionalStatusDate).toBeNull();
    expect(cleared.closeout).toBeNull();
    expect((await assessmentEvents(again))[0]).toMatchObject({
      before: { conditionalStatusDate: '2026-03-01' },
      after: { conditionalStatusDate: null },
    });
  });

  it('writes no event and keeps updatedAt on a no-op', async () => {
    const { h, admin } = await world();
    const initial = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    h.clock.advance(60_000);
    const first = await save(admin, { type: 'self', conditionalStatusDate: null });
    expect(await assessmentEvents(admin)).toHaveLength(1);
    expect(first.assessment.updatedAt).toBe(initial.assessment.updatedAt);

    const changed = await save(admin, { type: 'c3pao', conditionalStatusDate: '2026-11-01' });
    expect(await assessmentEvents(admin)).toHaveLength(2);
    expect((await assessmentEvents(admin))[0]).toMatchObject({
      before: { type: 'self', conditionalStatusDate: null },
      after: { type: 'c3pao', conditionalStatusDate: '2026-11-01' },
    });
    h.clock.advance(60_000);
    const again = await save(admin, { conditionalStatusDate: '2026-11-01' });
    expect(await assessmentEvents(admin)).toHaveLength(2);
    expect(again.assessment).toEqual(changed.assessment);
  });
});
