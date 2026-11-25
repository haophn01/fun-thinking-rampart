import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, evidenceVersion } from '../../db/schema';
import {
  UPLOAD_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  auditPageSchema,
  errorEnvelopeSchema,
  evidenceItemResponseSchema,
  type AuditPage,
  type EvidenceItem,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  return { h, admin: await h.setupAdmin() };
}

const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function errorOf(body: string) {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error;
}

async function create(client: Client, containsCui: boolean): Promise<EvidenceItem> {
  const response = await client.post('/api/evidence', {
    title: containsCui ? 'CUI drawing' : 'Firewall config export',
    description: null,
    containsCui,
  });
  expect(response.statusCode, response.body).toBe(201);
  return evidenceItemResponseSchema.parse(response.json()).item;
}

const versionsUrl = (id: string) => `/api/evidence/${id}/versions`;

async function upload(client: Client, id: string, bytes: Uint8Array, name: string | null) {
  return client.upload(versionsUrl(id), bytes, name);
}

async function events(client: Client, id: string): Promise<AuditPage['events']> {
  const response = await client.get(`/api/audit?entityType=evidence_item&entityId=${id}`);
  return auditPageSchema.parse(response.json()).events;
}

describe('file versions', () => {
  it('numbers versions 1 and 2, newest first, with sha256 matching the bytes', async () => {
    const { h, admin } = await world();
    const item = await create(admin, false);
    const one = bytesOf('first export');
    const two = bytesOf('second export, longer');

    const first = await upload(admin, item.id, one, 'firewall.txt');
    expect(first.statusCode, first.body).toBe(201);
    h.clock.advance(60_000);
    const second = await upload(admin, item.id, two, 'Firewall v2.TXT');
    expect(second.statusCode, second.body).toBe(201);

    const { item: updated } = evidenceItemResponseSchema.parse(second.json());
    expect(updated.versions).toEqual([
      {
        kind: 'file',
        version: 2,
        fileName: 'Firewall v2.TXT',
        size: two.length,
        sha256: sha256(two),
        createdAt: h.clock.now().toISOString(),
        createdBy: { id: admin.user?.id, displayName: 'Ada Admin' },
      },
      expect.objectContaining({ kind: 'file', version: 1, sha256: sha256(one), size: one.length }),
    ]);
    expect(updated.updatedAt).toBe(h.clock.now().toISOString());
    expect(h.store.keys().sort()).toEqual([sha256(one), sha256(two)].sort());
  });

  it('the same bytes and name as the newest give 200 with no new version or event', async () => {
    const { admin } = await world();
    const item = await create(admin, false);
    const bytes = bytesOf('same');
    expect((await upload(admin, item.id, bytes, 'a.txt')).statusCode).toBe(201);
    const repeat = await upload(admin, item.id, bytes, 'a.txt');
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(evidenceItemResponseSchema.parse(repeat.json()).item.versions).toHaveLength(1);
    const added = (await events(admin, item.id)).filter(
      (e) => e.action === 'evidence.version_added',
    );
    expect(added).toHaveLength(1);
  });

  it('the same bytes under a new name make a new version but one stored file', async () => {
    const { h, admin } = await world();
    const item = await create(admin, false);
    const bytes = bytesOf('renamed');
    expect((await upload(admin, item.id, bytes, 'a.txt')).statusCode).toBe(201);
    const renamed = await upload(admin, item.id, bytes, 'b.txt');
    expect(renamed.statusCode).toBe(201);
    const { item: updated } = evidenceItemResponseSchema.parse(renamed.json());
    expect(updated.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(h.store.keys()).toEqual([sha256(bytes)]);

    // Back to the first name: it matches version 1, not the newest, so it is a new version.
    const back = await upload(admin, item.id, bytes, 'a.txt');
    expect(back.statusCode).toBe(201);
    expect(evidenceItemResponseSchema.parse(back.json()).item.versions).toHaveLength(3);
  });

  it('numbers each item on its own', async () => {
    const { admin } = await world();
    const a = await create(admin, false);
    const b = await create(admin, false);
    await upload(admin, a.id, bytesOf('a1'), 'a.txt');
    await upload(admin, a.id, bytesOf('a2'), 'a.txt');
    const response = await upload(admin, b.id, bytesOf('b1'), 'b.txt');
    expect(evidenceItemResponseSchema.parse(response.json()).item.versions[0]?.version).toBe(1);
  });
});

describe('CUI refuses a file', () => {
  it('gives 409 cui_file_refused, the store stays empty and no version row exists', async () => {
    const { h, admin } = await world();
    const item = await create(admin, true);
    const response = await upload(admin, item.id, bytesOf('controlled drawing'), 'drawing.pdf');
    expect(response.statusCode).toBe(409);
    expect(errorOf(response.body).code).toBe('cui_file_refused');
    expect(h.store.keys()).toEqual([]);
    expect(h.db.select().from(evidenceVersion).all()).toEqual([]);
    expect(await events(admin, item.id)).toHaveLength(1);
  });

  it('a bad file type on a CUI item is a 415 first, and an unknown item is a 404', async () => {
    const { h, admin } = await world();
    const item = await create(admin, true);
    const bad = await upload(admin, item.id, bytesOf('x'), 'evil.exe');
    expect(bad.statusCode).toBe(415);
    const unknown = await upload(
      admin,
      '00000000-0000-4000-8000-000000000000',
      bytesOf('x'),
      'a.txt',
    );
    expect(unknown.statusCode).toBe(404);
    expect(h.store.keys()).toEqual([]);
  });
});

describe('references', () => {
  it('a reference on a CUI item makes a reference version', async () => {
    const { h, admin } = await world();
    const item = await create(admin, true);
    const response = await admin.post(`/api/evidence/${item.id}/references`, {
      location: '  Enclave share \\\\cui-fs01\\drawings\\A-100.pdf  ',
      note: 'Ask the FSO for access',
    });
    expect(response.statusCode, response.body).toBe(201);
    const { item: updated } = evidenceItemResponseSchema.parse(response.json());
    expect(updated.versions).toEqual([
      {
        kind: 'reference',
        version: 1,
        location: 'Enclave share \\\\cui-fs01\\drawings\\A-100.pdf',
        note: 'Ask the FSO for access',
        createdAt: h.clock.now().toISOString(),
        createdBy: { id: admin.user?.id, displayName: 'Ada Admin' },
      },
    ]);
    const second = await admin.post(`/api/evidence/${item.id}/references`, {
      location: 'Moved to the vault',
      note: null,
    });
    expect(second.statusCode).toBe(201);
    const versions = evidenceItemResponseSchema.parse(second.json()).item.versions;
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(h.store.keys()).toEqual([]);

    const [added] = (await events(admin, item.id)).filter(
      (e) => e.action === 'evidence.version_added',
    );
    expect(added).toMatchObject({
      before: null,
      after: { version: 2, kind: 'reference', location: 'Moved to the vault', note: null },
    });
  });

  it('an identical repeat of the newest reference gives 200 with no new version', async () => {
    const { admin } = await world();
    const item = await create(admin, true);
    const body = { location: 'Vault drawer 3', note: null };
    expect((await admin.post(`/api/evidence/${item.id}/references`, body)).statusCode).toBe(201);
    const repeat = await admin.post(`/api/evidence/${item.id}/references`, body);
    expect(repeat.statusCode).toBe(200);
    expect(evidenceItemResponseSchema.parse(repeat.json()).item.versions).toHaveLength(1);
  });

  it('on a plain item, a reference gives 409 evidence_not_cui and writes nothing', async () => {
    const { h, admin } = await world();
    const item = await create(admin, false);
    const response = await admin.post(`/api/evidence/${item.id}/references`, {
      location: 'Somewhere',
      note: null,
    });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response.body).code).toBe('evidence_not_cui');
    expect(h.db.select().from(evidenceVersion).all()).toEqual([]);
  });

  it('a bad reference body is a 400', async () => {
    const { admin } = await world();
    const item = await create(admin, true);
    for (const body of [
      { location: '   ', note: null },
      { location: 'x'.repeat(1001), note: null },
    ]) {
      const response = await admin.post(`/api/evidence/${item.id}/references`, body);
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('upload limits', () => {
  it('exactly 25 MiB gives 201 and 25 MiB + 1 gives 413', async () => {
    const { h, admin } = await world();
    const item = await create(admin, false);
    const max = new Uint8Array(UPLOAD_MAX_BYTES).fill(7);
    const ok = await upload(admin, item.id, max, 'big.zip');
    expect(ok.statusCode, ok.body.slice(0, 200)).toBe(201);
    const over = new Uint8Array(UPLOAD_MAX_BYTES + 1).fill(8);
    const tooBig = await upload(admin, item.id, over, 'bigger.zip');
    expect(tooBig.statusCode).toBe(413);
    expect(errorOf(tooBig.body).code).toBe('payload_too_large');
    expect(h.store.keys()).toEqual([sha256(max)]);
  });

  it('refuses an empty file, .exe, a JSON body and a missing name, storing nothing', async () => {
    const { h, admin } = await world();
    const item = await create(admin, false);

    const empty = await upload(admin, item.id, new Uint8Array(0), 'empty.txt');
    expect(empty.statusCode).toBe(400);
    expect(errorOf(empty.body).code).toBe('validation_failed');

    const exe = await upload(admin, item.id, bytesOf('MZ'), 'setup.pdf.exe');
    expect(exe.statusCode).toBe(415);
    const exeError = errorOf(exe.body);
    expect(exeError.code).toBe('unsupported_file_type');
    expect(exeError.details).toEqual({ allowed: [...UPLOAD_EXTENSIONS] });

    const json = await admin.post(versionsUrl(item.id), { fileName: 'a.txt' });
    expect(json.statusCode).toBe(415);
    expect(errorOf(json.body).code).toBe('unsupported_media_type');

    const noName = await upload(admin, item.id, bytesOf('x'), null);
    expect(noName.statusCode).toBe(400);
    expect(errorOf(noName.body).code).toBe('validation_failed');

    expect(h.store.keys()).toEqual([]);
    expect(h.db.select().from(evidenceVersion).all()).toEqual([]);
  });

  it('an upload without CSRF gives 403 with nothing stored', async () => {
    const { h, admin } = await world();
    const item = await create(admin, false);
    const response = await admin.upload(versionsUrl(item.id), bytesOf('x'), 'a.txt', {
      headers: { 'x-csrf-token': null },
    });
    expect(response.statusCode).toBe(403);
    expect(errorOf(response.body).code).toBe('csrf_failed');
    const signedOut = await h.client().upload(versionsUrl(item.id), bytesOf('x'), 'a.txt');
    expect(signedOut.statusCode).toBe(401);
    expect(h.store.keys()).toEqual([]);
    expect(h.db.select().from(evidenceVersion).all()).toEqual([]);
  });

  it('JSON routes still refuse an octet-stream body', async () => {
    const { admin } = await world();
    const response = await admin.request('POST', '/api/evidence', {
      rawBody: bytesOf('{"title":"x","description":null,"containsCui":false}'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('audit', () => {
  it('version_added carries {version, kind, fileName, size, sha256}, and no event holds file bytes', async () => {
    const { h, admin } = await world();
    const item = await create(admin, false);
    const secret = 'TOP-SECRET-FILE-CONTENT-7f3a';
    const bytes = bytesOf(secret);
    await upload(admin, item.id, bytes, 'Política 1.pdf');

    const [added] = (await events(admin, item.id)).filter(
      (e) => e.action === 'evidence.version_added',
    );
    expect(added).toMatchObject({ entityType: 'evidence_item', entityId: item.id, before: null });
    expect(added?.after).toEqual({
      version: 1,
      kind: 'file',
      fileName: 'Política 1.pdf',
      size: bytes.length,
      sha256: sha256(bytes),
    });

    const rows = h.db.select().from(auditEvent).all();
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain(Buffer.from(secret).toString('base64'));
    expect(JSON.stringify(h.logs)).not.toContain(secret);
  });
});
