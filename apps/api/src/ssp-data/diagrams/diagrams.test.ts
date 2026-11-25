import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from '../../../db/client';
import { auditEvent, diagramLink } from '../../../db/schema';
import { createMemoryStore } from '../../../storage';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  auditPageSchema,
  diagramResponseSchema,
  diagramsResponseSchema,
  errorEnvelopeSchema,
  evidenceItemResponseSchema,
  sessionResponseSchema,
  type AuditPage,
  type DiagramLink,
  type EvidenceItem,
} from '../../contract';
import { ADMIN, START, createHarness, type Client, type Harness } from '../../testing/harness';
import { loadDiagramLinks } from './repository';

const URL = '/api/ssp/diagrams';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const harnesses: Harness[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  return { h, admin: await h.setupAdmin() };
}

const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function diagramOf(response: LightMyRequestResponse, status = 200): DiagramLink {
  expect(response.statusCode, response.body).toBe(status);
  return diagramResponseSchema.parse(response.json()).diagram;
}

async function list(client: Client): Promise<DiagramLink[]> {
  const response = await client.get(URL);
  expect(response.statusCode, response.body).toBe(200);
  return diagramsResponseSchema.parse(response.json()).diagrams;
}

function errorOf(response: LightMyRequestResponse) {
  return errorEnvelopeSchema.parse(response.json()).error;
}

async function events(client: Client, id: string): Promise<AuditPage['events']> {
  const response = await client.get(`/api/audit?entityType=diagram_link&entityId=${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return auditPageSchema.parse(response.json()).events;
}

async function evidence(client: Client, title: string, containsCui: boolean) {
  const response = await client.post('/api/evidence', { title, description: null, containsCui });
  expect(response.statusCode, response.body).toBe(201);
  return evidenceItemResponseSchema.parse(response.json()).item;
}

async function uploadFile(client: Client, item: EvidenceItem, text: string, fileName: string) {
  const response = await client.upload(
    `/api/evidence/${item.id}/versions`,
    bytesOf(text),
    fileName,
  );
  expect(response.statusCode, response.body).toBe(201);
}

async function addReference(client: Client, item: EvidenceItem, location: string) {
  const response = await client.post(`/api/evidence/${item.id}/references`, {
    location,
    note: null,
  });
  expect(response.statusCode, response.body).toBe(201);
}

async function link(
  client: Client,
  item: EvidenceItem,
  body: { kind?: string; caption?: string; version?: number | null } = {},
): Promise<DiagramLink> {
  return diagramOf(
    await client.post(URL, {
      evidenceId: item.id,
      kind: 'network',
      caption: 'Network diagram',
      version: null,
      ...body,
    }),
    201,
  );
}

function dropAssessment(h: Harness): void {
  h.handle.sqlite.pragma('foreign_keys = OFF');
  h.handle.sqlite.exec('DELETE FROM assessment');
  h.handle.sqlite.pragma('foreign_keys = ON');
}

describe('diagram links', () => {
  it('embeddable', async () => {
    const { h, admin } = await world();
    const png = await evidence(admin, 'Network map', false);
    await uploadFile(admin, png, 'png bytes', 'network.PNG');
    const pdf = await evidence(admin, 'Data flow', false);
    await uploadFile(admin, pdf, 'pdf bytes', 'flow.pdf');
    const cui = await evidence(admin, 'Enclave drawing', true);
    await addReference(admin, cui, 'SharePoint CUI site / drawings / enclave.png');

    const pngLink = await link(admin, png);
    expect(pngLink).toEqual({
      id: expect.any(String) as string,
      kind: 'network',
      caption: 'Network diagram',
      evidence: { id: png.id, title: 'Network map', containsCui: false },
      version: null,
      resolved: {
        version: 1,
        kind: 'file',
        fileName: 'network.PNG',
        size: bytesOf('png bytes').length,
        sha256: sha256(bytesOf('png bytes')),
        location: null,
        createdAt: START.toISOString(),
      },
      embeddable: true,
      createdAt: START.toISOString(),
      updatedAt: START.toISOString(),
    });

    const pdfLink = await link(admin, pdf, { kind: 'data_flow', caption: 'CUI flow' });
    expect(pdfLink.resolved).toMatchObject({ kind: 'file', fileName: 'flow.pdf' });
    expect(pdfLink.embeddable).toBe(false);

    // A CUI item links, resolves to its reference, and is never embeddable, even named .png.
    const cuiLink = await link(admin, cui, { caption: 'Enclave' });
    expect(cuiLink.evidence).toEqual({ id: cui.id, title: 'Enclave drawing', containsCui: true });
    expect(cuiLink.resolved).toEqual({
      version: 1,
      kind: 'reference',
      fileName: null,
      size: null,
      sha256: null,
      location: 'SharePoint CUI site / drawings / enclave.png',
      createdAt: START.toISOString(),
    });
    expect(cuiLink.embeddable).toBe(false);
    // Pinned to that version, it is still not embeddable.
    expect((await link(admin, cui, { version: 1 })).embeddable).toBe(false);

    // The list agrees with what each write answered.
    const listed = await list(admin);
    expect(listed.find((d) => d.id === pngLink.id)).toEqual(pngLink);
    expect(listed.filter((d) => d.embeddable).map((d) => d.id)).toEqual([pngLink.id]);

    // The link never reads the file bytes: corrupted stored files change nothing in the list.
    for (const key of h.store.keys()) h.store.corrupt(key);
    expect(await list(admin)).toEqual(listed);
  });

  it('version resolution', async () => {
    const { h, admin } = await world();
    const item = await evidence(admin, 'Network map', false);

    // No versions yet: resolved is null and nothing is embeddable.
    const early = await link(admin, item);
    expect(early).toMatchObject({ version: null, resolved: null, embeddable: false });

    await uploadFile(admin, item, 'first', 'map.png');
    const pinned = await link(admin, item, { version: 1, caption: 'Pinned' });
    expect(pinned.resolved).toMatchObject({ version: 1, fileName: 'map.png' });

    // A later upload: the null link follows it, the pinned one doesn't.
    h.clock.advance(60_000);
    await uploadFile(admin, item, 'second', 'map-v2.pdf');
    const after = await list(admin);
    const floating = after.find((d) => d.id === early.id);
    expect(floating?.resolved).toMatchObject({
      version: 2,
      fileName: 'map-v2.pdf',
      sha256: sha256(bytesOf('second')),
      createdAt: h.clock.now().toISOString(),
    });
    expect(floating?.embeddable).toBe(false);
    const stillPinned = after.find((d) => d.id === pinned.id);
    expect(stillPinned?.resolved).toMatchObject({ version: 1, fileName: 'map.png' });
    expect(stillPinned?.embeddable).toBe(true);

    // Re-pinning moves it; unpinning follows the newest again.
    const moved = diagramOf(await admin.patch(`${URL}/${pinned.id}`, { version: 2 }));
    expect(moved.resolved?.version).toBe(2);
    const unpinned = diagramOf(await admin.patch(`${URL}/${early.id}`, { version: 1 }));
    expect(unpinned).toMatchObject({ version: 1, embeddable: true });
    const followed = diagramOf(await admin.patch(`${URL}/${early.id}`, { version: null }));
    expect(followed).toMatchObject({ version: null, resolved: { version: 2 } });
  });

  it('link validation', async () => {
    const { h, admin } = await world();
    const item = await evidence(admin, 'Network map', false);
    await uploadFile(admin, item, 'one', 'map.png');

    // Unknown evidence: 400 on evidenceId; a non-UUID is a 400 too.
    for (const evidenceId of [MISSING_ID, 'not-a-uuid']) {
      const refused = await admin.post(URL, {
        evidenceId,
        kind: 'network',
        caption: 'X',
        version: null,
      });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(errorOf(refused).code).toBe('validation_failed');
      expect(errorOf(refused).details).toEqual([expect.objectContaining({ path: ['evidenceId'] })]);
    }

    // A pinned version the item doesn't have: 400 on version, on create and on patch.
    const missingVersion = await admin.post(URL, {
      evidenceId: item.id,
      kind: 'network',
      caption: 'X',
      version: 2,
    });
    expect(missingVersion.statusCode, missingVersion.body).toBe(400);
    expect(errorOf(missingVersion).details).toEqual([
      expect.objectContaining({ path: ['version'] }),
    ]);

    // Bad bodies: version is a required key; unknown keys, version 0, blank caption, bad kind.
    for (const body of [
      { evidenceId: item.id, kind: 'network', caption: 'X' },
      { evidenceId: item.id, kind: 'network', caption: 'X', version: 0 },
      { evidenceId: item.id, kind: 'network', caption: '  ', version: null },
      { evidenceId: item.id, kind: 'topology', caption: 'X', version: null },
      { evidenceId: item.id, kind: 'network', caption: 'X', version: null, extra: 1 },
    ]) {
      const bad = await admin.post(URL, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(h.db.select().from(diagramLink).all()).toEqual([]);

    // Linking the same item twice makes two links.
    const first = await link(admin, item);
    const second = await link(admin, item);
    expect(second.id).not.toBe(first.id);
    expect((await list(admin)).map((d) => d.id).sort()).toEqual([first.id, second.id].sort());

    const badPin = await admin.patch(`${URL}/${first.id}`, { version: 5 });
    expect(badPin.statusCode, badPin.body).toBe(400);
    expect(errorOf(badPin).details).toEqual([expect.objectContaining({ path: ['version'] })]);
    // The evidence item can't change on a patch, and {} is refused.
    const other = await evidence(admin, 'Other', false);
    for (const body of [{ evidenceId: other.id }, {}, { caption: '' }, { version: 0 }]) {
      const bad = await admin.patch(`${URL}/${first.id}`, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await list(admin)).find((d) => d.id === first.id)).toEqual(first);
    expect(await events(admin, first.id)).toHaveLength(1);
  });

  it('diagram lifecycle', async () => {
    const { h, admin } = await world();
    const assessmentId = (
      h.handle.sqlite.prepare('SELECT id FROM assessment').get() as { id: string }
    ).id;
    const item = await evidence(admin, 'Network map', false);
    await uploadFile(admin, item, 'one', 'map.png');

    const made = await link(admin, item, { caption: ' Main network ', version: 1 });
    expect(made.caption).toBe('Main network');
    let history = await events(admin, made.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'diagram_link.created',
      entityType: 'diagram_link',
      entityId: made.id,
      before: null,
      after: { evidenceId: item.id, kind: 'network', caption: 'Main network', version: 1 },
    });

    // A change audits only the changed fields and moves updatedAt.
    h.clock.advance(60_000);
    const changed = diagramOf(
      await admin.patch(`${URL}/${made.id}`, { kind: 'data_flow', caption: 'Main network' }),
    );
    expect(changed).toMatchObject({ kind: 'data_flow', updatedAt: h.clock.now().toISOString() });
    expect(changed.createdAt).toBe(START.toISOString());
    history = await events(admin, made.id);
    expect(history[0]).toMatchObject({
      action: 'diagram_link.updated',
      before: { kind: 'network' },
      after: { kind: 'data_flow' },
    });

    // A no-op patch writes nothing and keeps updatedAt.
    h.clock.advance(60_000);
    const same = diagramOf(
      await admin.patch(`${URL}/${made.id}`, { caption: ' Main network ', version: 1 }),
    );
    expect(same).toEqual(changed);
    expect(await events(admin, made.id)).toHaveLength(2);

    // Order: kind order, then createdAt.
    h.clock.advance(1000);
    const other = await link(admin, item, { kind: 'other', caption: 'Rack photo' });
    h.clock.advance(1000);
    const net = await link(admin, item, { kind: 'network', caption: 'Later network' });
    h.clock.advance(1000);
    const net2 = await link(admin, item, { kind: 'network', caption: 'A network' });
    expect((await list(admin)).map((d) => d.id)).toEqual([net.id, net2.id, made.id, other.id]);
    expect(loadDiagramLinks(h.db, assessmentId)).toEqual(await list(admin));

    // Removal: 204, an event with every stored field before, gone from the list.
    h.clock.advance(60_000);
    const removed = await admin.delete(`${URL}/${made.id}`);
    expect(removed.statusCode, removed.body).toBe(204);
    history = await events(admin, made.id);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({
      action: 'diagram_link.removed',
      before: { evidenceId: item.id, kind: 'data_flow', caption: 'Main network', version: 1 },
      after: null,
    });
    expect((await list(admin)).map((d) => d.id)).toEqual([net.id, net2.id, other.id]);
    const row = h.db
      .select()
      .from(diagramLink)
      .all()
      .find((r) => r.id === made.id);
    expect(row?.removedAt).toBe(h.clock.now().toISOString());

    // A second DELETE, a PATCH of a removed link and an unknown id: 404, nothing written.
    expect((await admin.delete(`${URL}/${made.id}`)).statusCode).toBe(404);
    const patchRemoved = await admin.patch(`${URL}/${made.id}`, { caption: 'Back' });
    expect(patchRemoved.statusCode).toBe(404);
    expect(errorOf(patchRemoved).code).toBe('not_found');
    expect((await admin.patch(`${URL}/${MISSING_ID}`, { caption: 'Y' })).statusCode).toBe(404);
    expect((await admin.patch(`${URL}/${MISSING_ID}`, {})).statusCode).toBe(400);
    expect(await events(admin, made.id)).toHaveLength(3);
    for (const e of h.db.select().from(auditEvent).all()) {
      if (e.entityType === 'diagram_link') expect(e.assessmentId).toBe(assessmentId);
    }

    // Access: signed out 401, missing CSRF 403; no assessment 404 after a 400 body check.
    const anonymous = h.client();
    expect((await anonymous.get(URL)).statusCode).toBe(401);
    const forged = await admin.delete(`${URL}/${net.id}`, { headers: { [CSRF_HEADER]: null } });
    expect(forged.statusCode).toBe(403);
    expect(errorOf(forged).code).toBe('csrf_failed');
    dropAssessment(h);
    expect((await admin.get(URL)).statusCode).toBe(404);
    const body = { evidenceId: item.id, kind: 'network', caption: 'X', version: null };
    expect((await admin.post(URL, body)).statusCode).toBe(404);
    expect((await admin.post(URL, { ...body, caption: '' })).statusCode).toBe(400);
  });

  it('links survive a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-diagrams-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'rampart.sqlite');
    const now = () => START;
    const store = createMemoryStore();

    function start(): { app: FastifyInstance; handle: DbHandle } {
      const handle = openDb(path);
      runMigrations(handle.db);
      const config = loadConfig({ DATABASE_PATH: path, LOG_LEVEL: 'silent' });
      const app = buildApp({ config, db: handle.db, now, store });
      cleanups.push(async () => {
        await app.close();
        if (handle.sqlite.open) handle.sqlite.close();
      });
      return { app, handle };
    }

    async function session(app: FastifyInstance, url: string, payload: unknown) {
      const response = await app.inject({ method: 'POST', url, payload: payload as object });
      expect(response.statusCode, response.body).toBeLessThan(300);
      const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
      const { csrfToken } = sessionResponseSchema.parse(response.json());
      return { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrfToken ?? '' };
    }

    const first = start();
    const headers = await session(first.app, '/api/setup', ADMIN);
    const json = { ...headers, 'content-type': 'application/json' };
    const made = await first.app.inject({
      method: 'POST',
      url: '/api/evidence',
      headers: json,
      payload: JSON.stringify({ title: 'Map', description: null, containsCui: false }),
    });
    const item = evidenceItemResponseSchema.parse(made.json()).item;
    const uploaded = await first.app.inject({
      method: 'POST',
      url: `/api/evidence/${item.id}/versions`,
      headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': 'a.png' },
      payload: Buffer.from('png'),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const post = (payload: unknown) =>
      first.app.inject({
        method: 'POST',
        url: URL,
        headers: json,
        payload: JSON.stringify(payload),
      });
    diagramOf(await post({ evidenceId: item.id, kind: 'network', caption: 'N', version: 1 }), 201);
    const gone = diagramOf(
      await post({ evidenceId: item.id, kind: 'other', caption: 'Gone', version: null }),
      201,
    );
    diagramOf(
      await post({ evidenceId: item.id, kind: 'data_flow', caption: 'F', version: null }),
      201,
    );
    const removed = await first.app.inject({ method: 'DELETE', url: `${URL}/${gone.id}`, headers });
    expect(removed.statusCode).toBe(204);
    const before = diagramsResponseSchema.parse(
      (await first.app.inject({ method: 'GET', url: URL, headers })).json(),
    ).diagrams;
    expect(before.map((d) => d.caption)).toEqual(['N', 'F']);
    await first.app.close();
    first.handle.sqlite.close();

    const second = start();
    const again = await session(second.app, '/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    const read = await second.app.inject({ method: 'GET', url: URL, headers: again });
    expect(read.statusCode, read.body).toBe(200);
    expect(diagramsResponseSchema.parse(read.json()).diagrams).toEqual(before);
  });
});
