import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from '../../../db/client';
import { asset, auditEvent } from '../../../db/schema';
import { createMemoryStore } from '../../../storage';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import {
  CSRF_HEADER,
  assetResponseSchema,
  assetsResponseSchema,
  auditPageSchema,
  errorEnvelopeSchema,
  userResponseSchema,
  type Asset,
  type AuditPage,
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
import { loadAssets } from './repository';

const URL = '/api/ssp/assets';
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
  return { h, admin: await h.setupAdmin() };
}

function assetOf(response: LightMyRequestResponse, status = 200): Asset {
  expect(response.statusCode, response.body).toBe(status);
  return assetResponseSchema.parse(response.json()).asset;
}

async function list(client: Client): Promise<Asset[]> {
  const response = await client.get(URL);
  expect(response.statusCode, response.body).toBe(200);
  return assetsResponseSchema.parse(response.json()).assets;
}

function errorOf(response: LightMyRequestResponse) {
  return errorEnvelopeSchema.parse(response.json()).error;
}

async function events(client: Client, id: string): Promise<AuditPage['events']> {
  const response = await client.get(`/api/audit?entityType=asset&entityId=${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return auditPageSchema.parse(response.json()).events;
}

async function create(client: Client, body: Record<string, unknown>): Promise<Asset> {
  return assetOf(await client.post(URL, body), 201);
}

function activeAssessmentId(h: Harness): string {
  const row = h.handle.sqlite.prepare('SELECT id FROM assessment').get() as { id: string };
  return row.id;
}

function dropAssessment(h: Harness): void {
  h.handle.sqlite.pragma('foreign_keys = OFF');
  h.handle.sqlite.exec('DELETE FROM assessment');
  h.handle.sqlite.pragma('foreign_keys = ON');
}

describe('assets', () => {
  it('out-of-scope justification', async () => {
    const { h, admin } = await world();

    // Create: out of scope with no justification, or a blank one, is a 400 on that path.
    for (const outOfScopeJustification of [undefined, null, '   ']) {
      const body = { name: 'Guest Wi-Fi', category: 'out_of_scope', outOfScopeJustification };
      const refused = await admin.post(URL, body);
      expect(refused.statusCode, refused.body).toBe(400);
      expect(errorOf(refused).code).toBe('validation_failed');
      expect(JSON.stringify(errorOf(refused).details)).toContain('outOfScopeJustification');
    }
    expect(h.db.select().from(asset).all()).toEqual([]);

    // With one, it saves.
    const wifi = await create(admin, {
      name: 'Guest Wi-Fi',
      category: 'out_of_scope',
      outOfScopeJustification: ' Isolated VLAN, no CUI ',
    });
    expect(wifi.outOfScopeJustification).toBe('Isolated VLAN, no CUI');

    // Blanking it while out of scope: 400, nothing changes, no event.
    for (const blank of [null, '  ']) {
      const blanked = await admin.patch(`${URL}/${wifi.id}`, { outOfScopeJustification: blank });
      expect(blanked.statusCode, blanked.body).toBe(400);
      expect(errorOf(blanked).code).toBe('validation_failed');
      expect(errorOf(blanked).details).toEqual([
        expect.objectContaining({ path: ['outOfScopeJustification'] }),
      ]);
    }

    // Switching a category to out of scope without one: 400.
    const laptop = await create(admin, { name: 'Laptop', category: 'cui' });
    const switched = await admin.patch(`${URL}/${laptop.id}`, { category: 'out_of_scope' });
    expect(switched.statusCode, switched.body).toBe(400);
    expect(errorOf(switched).details).toEqual([
      expect.objectContaining({ path: ['outOfScopeJustification'] }),
    ]);
    // Switching and blanking in one go is refused too.
    const both = await admin.patch(`${URL}/${wifi.id}`, {
      category: 'out_of_scope',
      outOfScopeJustification: '',
    });
    expect(both.statusCode).toBe(400);

    // Switching with one in the same patch saves.
    const moved = assetOf(
      await admin.patch(`${URL}/${laptop.id}`, {
        category: 'out_of_scope',
        outOfScopeJustification: 'Retired',
      }),
    );
    expect(moved).toMatchObject({ category: 'out_of_scope', outOfScopeJustification: 'Retired' });

    // A justification on another category is kept, and then can be blanked.
    const back = assetOf(await admin.patch(`${URL}/${laptop.id}`, { category: 'spa' }));
    expect(back).toMatchObject({ category: 'spa', outOfScopeJustification: 'Retired' });
    const cleared = assetOf(
      await admin.patch(`${URL}/${laptop.id}`, { outOfScopeJustification: null }),
    );
    expect(cleared.outOfScopeJustification).toBeNull();

    // A create on another category keeps a justification sent with it.
    const kept = await create(admin, {
      name: 'Printer',
      category: 'crma',
      outOfScopeJustification: 'Was out of scope',
    });
    expect(kept.outOfScopeJustification).toBe('Was out of scope');

    // The refused writes left the stored rows as they were.
    expect((await list(admin)).find((a) => a.id === wifi.id)).toEqual(wifi);
    expect(await events(admin, wifi.id)).toHaveLength(1);
  });

  it('asset lifecycle', async () => {
    const { h, admin } = await world();
    const assessmentId = activeAssessmentId(h);
    const createdAt = START.toISOString();

    const server = await create(admin, {
      name: ' File server ',
      category: 'cui',
      assetType: 'Windows Server 2022',
      owner: '  ',
      location: 'HQ rack 2',
    });
    expect(server).toEqual({
      id: expect.any(String) as string,
      name: 'File server',
      category: 'cui',
      assetType: 'Windows Server 2022',
      owner: null,
      location: 'HQ rack 2',
      treatment: null,
      outOfScopeJustification: null,
      createdAt,
      updatedAt: createdAt,
    });
    let history = await events(admin, server.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'asset.created',
      entityType: 'asset',
      entityId: server.id,
      before: null,
      after: {
        name: 'File server',
        category: 'cui',
        assetType: 'Windows Server 2022',
        owner: null,
        location: 'HQ rack 2',
        treatment: null,
        outOfScopeJustification: null,
      },
    });

    // A change audits only the changed fields and moves updatedAt.
    h.clock.advance(60_000);
    const changedAt = h.clock.now().toISOString();
    const changed = assetOf(
      await admin.patch(`${URL}/${server.id}`, {
        name: 'File server',
        owner: 'IT',
        treatment: 'Encrypted at rest',
      }),
    );
    expect(changed).toMatchObject({ owner: 'IT', treatment: 'Encrypted at rest' });
    expect(changed.updatedAt).toBe(changedAt);
    expect(changed.createdAt).toBe(createdAt);
    history = await events(admin, server.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      action: 'asset.updated',
      before: { owner: null, treatment: null },
      after: { owner: 'IT', treatment: 'Encrypted at rest' },
    });

    // A no-op patch (trimmed spellings of the same values) writes nothing and keeps updatedAt.
    h.clock.advance(60_000);
    const same = assetOf(
      await admin.patch(`${URL}/${server.id}`, { name: ' File server ', owner: 'IT ' }),
    );
    expect(same).toEqual(changed);
    expect(await events(admin, server.id)).toHaveLength(2);
    expect(h.db.select().from(asset).all()[0]?.updatedAt).toBe(changedAt);

    // Bad bodies: 400 before anything else.
    for (const body of [{}, { nope: 1 }, { name: '' }, { category: 'cloud' }, { id: 'x' }]) {
      const bad = await admin.patch(`${URL}/${server.id}`, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
    }
    const badCreate = await admin.post(URL, { name: 'X', category: 'cui', extra: true });
    expect(badCreate.statusCode).toBe(400);
    // An unknown id: 404 on PATCH and DELETE, but a bad body is still a 400 first.
    expect((await admin.patch(`${URL}/${MISSING_ID}`, { name: 'Y' })).statusCode).toBe(404);
    expect((await admin.patch(`${URL}/${MISSING_ID}`, {})).statusCode).toBe(400);
    expect((await admin.delete(`${URL}/${MISSING_ID}`)).statusCode).toBe(404);

    // Removal: 204, an event with every stored field before, gone from the list.
    h.clock.advance(60_000);
    const removed = await admin.delete(`${URL}/${server.id}`);
    expect(removed.statusCode, removed.body).toBe(204);
    expect(removed.body).toBe('');
    history = await events(admin, server.id);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({
      action: 'asset.removed',
      before: {
        name: 'File server',
        category: 'cui',
        assetType: 'Windows Server 2022',
        owner: 'IT',
        location: 'HQ rack 2',
        treatment: 'Encrypted at rest',
        outOfScopeJustification: null,
      },
      after: null,
    });
    expect(await list(admin)).toEqual([]);
    expect(loadAssets(h.db, assessmentId)).toEqual([]);
    // The row is kept, soft-removed.
    const rows = h.db.select().from(asset).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.removedAt).toBe(h.clock.now().toISOString());

    // A second DELETE and a PATCH of a removed asset are 404, and write nothing.
    const again = await admin.delete(`${URL}/${server.id}`);
    expect(again.statusCode).toBe(404);
    expect(errorOf(again).code).toBe('not_found');
    expect((await admin.patch(`${URL}/${server.id}`, { name: 'Back' })).statusCode).toBe(404);
    expect(await events(admin, server.id)).toHaveLength(3);

    // Every event ties back to the assessment.
    const stored = h.db.select().from(auditEvent).all();
    for (const row of stored.filter((e) => e.entityType === 'asset')) {
      expect(row.assessmentId).toBe(assessmentId);
    }
  });

  it('access', async () => {
    const { h, admin } = await world();
    const created = userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);

    // A contributor creates, changes and removes, and is the one recorded.
    const made = await create(carl, { name: 'VPN', category: 'spa' });
    assetOf(await carl.patch(`${URL}/${made.id}`, { owner: 'Carl' }));
    expect((await events(admin, made.id))[0]?.actor?.id).toBe(created.user.id);

    const anonymous = h.client();
    expect((await anonymous.get(URL)).statusCode).toBe(401);
    expect((await anonymous.post(URL, { name: 'X', category: 'cui' })).statusCode).toBe(401);
    expect((await anonymous.delete(`${URL}/${made.id}`)).statusCode).toBe(401);

    const forged = await carl.post(
      URL,
      { name: 'Forged', category: 'cui' },
      { headers: { [CSRF_HEADER]: null } },
    );
    expect(forged.statusCode).toBe(403);
    expect(errorOf(forged).code).toBe('csrf_failed');
    const forgedDelete = await carl.delete(`${URL}/${made.id}`, {
      headers: { [CSRF_HEADER]: null },
    });
    expect(forgedDelete.statusCode).toBe(403);
    expect(await list(admin)).toHaveLength(1);

    expect((await carl.delete(`${URL}/${made.id}`)).statusCode).toBe(204);

    // No assessment: 404, but a bad body is still a 400 first.
    dropAssessment(h);
    expect((await admin.get(URL)).statusCode).toBe(404);
    expect((await admin.post(URL, { name: 'X', category: 'cui' })).statusCode).toBe(404);
    expect((await admin.post(URL, { name: '', category: 'cui' })).statusCode).toBe(400);
  });

  it('order', async () => {
    const { h, admin } = await world();
    const add = async (name: string, category: string) => {
      h.clock.advance(1000);
      const body: Record<string, unknown> = { name, category };
      if (category === 'out_of_scope') body.outOfScopeJustification = 'No CUI';
      return create(admin, body);
    };
    await add('zebra', 'out_of_scope');
    await add('beta', 'cui');
    await add('Alpha', 'cui');
    await add('alpha', 'cui');
    await add('Firewall', 'spa');
    await add('Badge reader', 'specialized');
    await add('printer', 'crma');
    await add('apple', 'spa');

    const names = (await list(admin)).map((a) => `${a.category}:${a.name}`);
    // Category order, then name ignoring case, then createdAt (Alpha before alpha).
    expect(names).toEqual([
      'cui:Alpha',
      'cui:alpha',
      'cui:beta',
      'spa:apple',
      'spa:Firewall',
      'crma:printer',
      'specialized:Badge reader',
      'out_of_scope:zebra',
    ]);
    // A rename re-sorts.
    const [first] = await list(admin);
    await admin.patch(`${URL}/${first?.id ?? ''}`, { name: 'gamma' });
    expect((await list(admin)).slice(0, 3).map((a) => a.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('persists across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-assets-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'rampart.sqlite');
    const now = () => START;

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
    const headers = { ...(await session(first.app, '/api/setup', ADMIN)) };
    const json = { ...headers, 'content-type': 'application/json' };
    const post = (payload: unknown) =>
      first.app.inject({
        method: 'POST',
        url: URL,
        headers: json,
        payload: JSON.stringify(payload),
      });
    assetOf(await post({ name: 'Laptop', category: 'cui', owner: 'IT' }), 201);
    const gone = assetOf(await post({ name: 'Old', category: 'spa' }), 201);
    assetOf(
      await post({ name: 'Kiosk', category: 'out_of_scope', outOfScopeJustification: 'Public' }),
      201,
    );
    const removed = await first.app.inject({
      method: 'DELETE',
      url: `${URL}/${gone.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
    const before = assetsResponseSchema.parse(
      (await first.app.inject({ method: 'GET', url: URL, headers })).json(),
    ).assets;
    expect(before.map((a) => a.name)).toEqual(['Laptop', 'Kiosk']);
    await first.app.close();
    first.handle.sqlite.close();

    const second = start();
    const again = await session(second.app, '/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    const read = await second.app.inject({ method: 'GET', url: URL, headers: again });
    expect(read.statusCode, read.body).toBe(200);
    expect(assetsResponseSchema.parse(read.json()).assets).toEqual(before);
  });
});
