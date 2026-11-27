import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from '../../../db/client';
import { systemRole } from '../../../db/schema';
import { createMemoryStore } from '../../../storage';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import {
  CSRF_HEADER,
  auditPageSchema,
  errorEnvelopeSchema,
  roleResponseSchema,
  rolesResponseSchema,
  userResponseSchema,
  type AuditPage,
  type RolesResponse,
  type SystemRole,
} from '../../contract';
import {
  ADMIN,
  HARNESS_SECRET_KEY,
  START,
  createHarness,
  signInThroughApi,
  type Client,
  type Harness,
  type MfaSecrets,
} from '../../testing/harness';

const URL = '/api/ssp/roles';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const harnesses: Harness[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

function roleOf(response: LightMyRequestResponse, status = 200): SystemRole {
  expect(response.statusCode, response.body).toBe(status);
  return roleResponseSchema.parse(response.json()).role;
}

async function list(client: Client): Promise<RolesResponse> {
  const response = await client.get(URL);
  expect(response.statusCode, response.body).toBe(200);
  return rolesResponseSchema.parse(response.json());
}

function code(response: LightMyRequestResponse): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

async function roleEvents(client: Client): Promise<AuditPage['events']> {
  const response = await client.get('/api/audit?entityType=system_role');
  expect(response.statusCode, response.body).toBe(200);
  return auditPageSchema.parse(response.json()).events;
}

function role(overrides: Record<string, unknown> = {}) {
  return { title: 'Administrator', userCount: 2, privileged: true, ...overrides };
}

function dropAssessment(h: Harness): void {
  h.handle.sqlite.pragma('foreign_keys = OFF');
  h.handle.sqlite.exec('DELETE FROM assessment');
  h.handle.sqlite.pragma('foreign_keys = ON');
}

describe('ssp role routes', () => {
  it('role lifecycle', async () => {
    const { h, admin } = await world();
    const assessmentId = h.handle.sqlite.prepare('select id from assessment').pluck().get();
    const created = userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
    const carlRef = { id: created.user.id, displayName: CONTRIBUTOR.displayName };

    // A contributor creates: texts trim, the optional texts default to null.
    const createdAt = h.clock.now().toISOString();
    const admins = roleOf(
      await carl.post(URL, role({ title: '  IT Administrator ', person: '  ' })),
      201,
    );
    expect(admins).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      title: 'IT Administrator',
      person: null,
      responsibilities: null,
      userCount: 2,
      privileged: true,
      createdAt,
      updatedAt: createdAt,
    });
    let events = await roleEvents(admin);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      at: createdAt,
      actor: carlRef,
      action: 'system_role.created',
      entityType: 'system_role',
      entityId: admins.id,
      before: null,
      after: {
        title: 'IT Administrator',
        person: null,
        responsibilities: null,
        userCount: 2,
        privileged: true,
      },
    });
    expect(h.db.select().from(systemRole).all()[0]).toMatchObject({
      assessmentId,
      createdBy: created.user.id,
      updatedBy: created.user.id,
      removedAt: null,
    });

    // A change audits only the changed fields.
    h.clock.advance(60_000);
    const changedAt = h.clock.now().toISOString();
    const changed = roleOf(
      await carl.patch(`${URL}/${admins.id}`, {
        title: 'IT Administrator',
        person: 'Pat Admin',
        userCount: 3,
      }),
    );
    expect(changed).toEqual({ ...admins, person: 'Pat Admin', userCount: 3, updatedAt: changedAt });
    events = await roleEvents(admin);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      action: 'system_role.updated',
      entityId: admins.id,
      before: { person: null, userCount: 2 },
      after: { person: 'Pat Admin', userCount: 3 },
    });
    expect(events[0]?.before).not.toHaveProperty('title');

    // The same values again write nothing and keep updatedAt.
    h.clock.advance(60_000);
    const same = roleOf(
      await carl.patch(`${URL}/${admins.id}`, { title: ' IT Administrator', userCount: 3 }),
    );
    expect(same).toEqual(changed);
    expect(await roleEvents(admin)).toHaveLength(2);

    // Bad bodies are 400 and change nothing.
    for (const body of [
      {},
      { title: '   ' },
      { title: null },
      { userCount: -1 },
      { userCount: 1_000_001 },
      { userCount: 1.5 },
      { privileged: 'yes' },
      { nope: true },
    ]) {
      const bad = await carl.patch(`${URL}/${admins.id}`, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
      expect(code(bad)).toBe('validation_failed');
    }
    for (const body of [
      {},
      { userCount: 1, privileged: false },
      role({ title: '' }),
      role({ privileged: undefined }),
      role({ extra: 1 }),
    ]) {
      expect((await carl.post(URL, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await list(admin)).roles).toEqual([changed]);

    // Unknown ids are 404.
    expect((await carl.patch(`${URL}/${MISSING_ID}`, { userCount: 1 })).statusCode).toBe(404);
    expect((await carl.patch(`${URL}/not-a-uuid`, { userCount: 1 })).statusCode).toBe(404);
    expect((await carl.delete(`${URL}/${MISSING_ID}`)).statusCode).toBe(404);

    // Removal is soft: 204, a removed event with every field before, gone from the list.
    h.clock.advance(60_000);
    const removedAt = h.clock.now().toISOString();
    const removed = await carl.delete(`${URL}/${admins.id}`);
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe('');
    events = await roleEvents(admin);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      at: removedAt,
      action: 'system_role.removed',
      entityId: admins.id,
      before: {
        title: 'IT Administrator',
        person: 'Pat Admin',
        responsibilities: null,
        userCount: 3,
        privileged: true,
      },
      after: null,
    });
    expect((await list(admin)).roles).toEqual([]);
    const rows = h.db.select().from(systemRole).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.removedAt).toBe(removedAt);

    // A removed role is gone: a second DELETE and a PATCH are 404, and nothing changes.
    const again = await carl.delete(`${URL}/${admins.id}`);
    expect(again.statusCode).toBe(404);
    expect(code(again)).toBe('not_found');
    const late = await carl.patch(`${URL}/${admins.id}`, { userCount: 9 });
    expect(late.statusCode).toBe(404);
    expect(code(late)).toBe('not_found');
    // A bad body on a removed role is still a 400 first.
    expect((await carl.patch(`${URL}/${admins.id}`, {})).statusCode).toBe(400);
    expect(await roleEvents(admin)).toHaveLength(3);
    expect(h.db.select().from(systemRole).all()[0]?.removedAt).toBe(removedAt);
  });

  it('access', async () => {
    const { h, admin } = await world();
    const made = roleOf(await admin.post(URL, role()), 201);

    // Signed out: 401 everywhere.
    const anonymous = h.client();
    expect((await anonymous.get(URL)).statusCode).toBe(401);
    expect((await anonymous.post(URL, role())).statusCode).toBe(401);
    expect((await anonymous.patch(`${URL}/${made.id}`, { userCount: 1 })).statusCode).toBe(401);
    expect((await anonymous.delete(`${URL}/${made.id}`)).statusCode).toBe(401);

    // No CSRF token: 403 csrf_failed on every write.
    const noCsrf = { headers: { [CSRF_HEADER]: null } };
    for (const response of [
      await admin.post(URL, role(), noCsrf),
      await admin.patch(`${URL}/${made.id}`, { userCount: 1 }, noCsrf),
      await admin.delete(`${URL}/${made.id}`, noCsrf),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(code(response)).toBe('csrf_failed');
    }
    expect((await list(admin)).roles).toEqual([made]);

    // No assessment: 404, but a bad body is still a 400 first.
    dropAssessment(h);
    expect((await admin.get(URL)).statusCode).toBe(404);
    expect(code(await admin.post(URL, role()))).toBe('not_found');
    expect((await admin.post(URL, {})).statusCode).toBe(400);
  });

  it('totals', async () => {
    const { h, admin } = await world();

    // No roles: empty list, 0/0.
    expect(await list(admin)).toEqual({ roles: [], totals: { users: 0, privilegedUsers: 0 } });

    // Roles made at the same moment are ordered by id; later ones after them (also by id).
    const a = roleOf(await admin.post(URL, role({ title: 'Admins', userCount: 2 })), 201);
    const b = roleOf(
      await admin.post(URL, role({ title: 'Staff', userCount: 40, privileged: false })),
      201,
    );
    h.clock.advance(1_000);
    const c = roleOf(await admin.post(URL, role({ title: 'Security', userCount: 3 })), 201);
    const d = roleOf(
      await admin.post(URL, role({ title: 'Guests', userCount: 0, privileged: false })),
      201,
    );
    const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : 1);
    const sameMoment = [a, b].sort(byId);
    const laterMoment = [c, d].sort(byId);
    let read = await list(admin);
    expect(read.roles.map(({ id }) => id)).toEqual(
      [...sameMoment, ...laterMoment].map(({ id }) => id),
    );
    expect(read.totals).toEqual({ users: 45, privilegedUsers: 5 });

    // Switching a role to privileged moves its users; removed roles count for neither.
    await admin.patch(`${URL}/${b.id}`, { privileged: true });
    expect((await list(admin)).totals).toEqual({ users: 45, privilegedUsers: 45 });
    expect((await admin.delete(`${URL}/${b.id}`)).statusCode).toBe(204);
    read = await list(admin);
    expect(read.roles.map(({ id }) => id)).not.toContain(b.id);
    expect(read.totals).toEqual({ users: 5, privilegedUsers: 5 });

    // Removing every role brings the totals back to 0/0.
    for (const { id } of [a, c, d]) await admin.delete(`${URL}/${id}`);
    expect(await list(admin)).toEqual({ roles: [], totals: { users: 0, privilegedUsers: 0 } });
  });

  it('persists across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-ssp-roles-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'rampart.sqlite');
    let at = START.getTime();
    const now = () => new Date(at);

    function start(): { app: FastifyInstance; handle: DbHandle } {
      const handle = openDb(path);
      runMigrations(handle.db);
      const config = loadConfig({
        DATABASE_PATH: path,
        LOG_LEVEL: 'silent',
        RAMPART_SECRET_KEY: HARNESS_SECRET_KEY,
      });
      const app = buildApp({ config, db: handle.db, now, store: createMemoryStore() });
      cleanups.push(async () => {
        await app.close();
        if (handle.sqlite.open) handle.sqlite.close();
      });
      return { app, handle };
    }

    // Setup or sign-in, then the MFA step as a user would, the secret kept across the restart.
    const secrets: MfaSecrets = new Map();
    async function session(app: FastifyInstance, url: string, payload: unknown) {
      return signInThroughApi(app, url, payload, { at: now(), secrets });
    }

    const first = start();
    const headers = await session(first.app, '/api/setup', ADMIN);
    const write = { ...headers, 'content-type': 'application/json' };
    // Titles out of alphabetical order, so creation order is what the list must keep.
    for (const title of ['Zeta users', 'Alpha admins', 'Middle managers']) {
      at += 60_000;
      const response = await first.app.inject({
        method: 'POST',
        url: URL,
        headers: write,
        payload: JSON.stringify(role({ title, userCount: 1 })),
      });
      roleOf(response, 201);
    }
    const before = rolesResponseSchema.parse(
      (await first.app.inject({ method: 'GET', url: URL, headers })).json(),
    );
    await first.app.close();
    first.handle.sqlite.close();

    const second = start();
    const again = await session(second.app, '/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    const read = await second.app.inject({ method: 'GET', url: URL, headers: again });
    expect(read.statusCode, read.body).toBe(200);
    const after = rolesResponseSchema.parse(read.json());
    expect(after).toEqual(before);
    expect(after.roles.map(({ title }) => title)).toEqual([
      'Zeta users',
      'Alpha admins',
      'Middle managers',
    ]);
    expect(after.totals).toEqual({ users: 3, privilegedUsers: 3 });
  });
});
