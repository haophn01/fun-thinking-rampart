import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { policyVersion } from '../../db/schema';
import { StorageError, createMemoryStore, type MemoryFileStore } from '../../storage';
import {
  FILE_INTEGRITY_MESSAGE,
  UPLOAD_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  auditPageSchema,
  errorEnvelopeSchema,
  policyListSchema,
  policyResponseSchema,
  type AuditPage,
  type Policy,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

async function world(): Promise<{ h: Harness; admin: Client; item: Policy }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  const response = await admin.post('/api/policies', { title: 'Access', description: null });
  expect(response.statusCode, response.body).toBe(201);
  return { h, admin, item: policyResponseSchema.parse(response.json()).item };
}

const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function errorOf(body: string) {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error;
}

async function events(client: Client, id: string): Promise<AuditPage['events']> {
  const response = await client.get(`/api/audit?entityType=policy&entityId=${id}`);
  return auditPageSchema.parse(response.json()).events;
}

describe('policy versions', () => {
  it('file versions', async () => {
    const { h, admin, item } = await world();
    const url = `/api/policies/${item.id}/versions`;
    const v1 = bytesOf('policy v1');
    const v2 = bytesOf('policy v2, revised');

    const first = await admin.upload(url, v1, 'Access policy.docx');
    expect(first.statusCode, first.body).toBe(201);
    expect(policyResponseSchema.parse(first.json()).item.versions).toMatchObject([
      { version: 1, fileName: 'Access policy.docx', size: v1.byteLength, sha256: sha256(v1) },
    ]);

    h.clock.advance(1000);
    const second = await admin.upload(url, v2, 'Política 2.pdf');
    expect(second.statusCode, second.body).toBe(201);
    const afterTwo = policyResponseSchema.parse(second.json()).item;
    expect(afterTwo.versions.map((v) => [v.version, v.fileName, v.sha256])).toEqual([
      [2, 'Política 2.pdf', sha256(v2)],
      [1, 'Access policy.docx', sha256(v1)],
    ]);
    expect(afterTwo.versions[0]?.createdBy.displayName).toBe('Ada Admin');
    expect(afterTwo.updatedAt).toBe(h.clock.now().toISOString());
    expect(h.store.keys().sort()).toEqual([sha256(v1), sha256(v2)].sort());

    // An identical repeat of the newest: 200, no new version, no event.
    const eventsBefore = await events(admin, item.id);
    const repeat = await admin.upload(url, v2, 'Política 2.pdf');
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(policyResponseSchema.parse(repeat.json()).item.versions).toHaveLength(2);
    expect(await events(admin, item.id)).toEqual(eventsBefore);

    // The same bytes under a new name: a new version, still one stored file.
    const renamed = await admin.upload(url, v2, 'Access policy v2.pdf');
    expect(renamed.statusCode).toBe(201);
    const afterThree = policyResponseSchema.parse(renamed.json()).item;
    expect(afterThree.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(h.store.keys()).toHaveLength(2);

    // Re-sending an older version (not the newest) makes a new version too.
    const older = await admin.upload(url, v1, 'Access policy.docx');
    expect(older.statusCode).toBe(201);
    expect(policyResponseSchema.parse(older.json()).item.versions[0]?.version).toBe(4);

    // Saved: the list read in a fresh session shows all four, newest first.
    const list = await (
      await h.signIn('admin@example.com', 'correct horse battery')
    ).get('/api/policies');
    const { items } = policyListSchema.parse(list.json());
    expect(items[0]?.versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
  });

  it('upload limits', async () => {
    const { h, admin, item } = await world();
    const url = `/api/policies/${item.id}/versions`;

    const tooBig = await admin.upload(url, new Uint8Array(UPLOAD_MAX_BYTES + 1), 'big.pdf');
    expect(tooBig.statusCode).toBe(413);
    expect(errorOf(tooBig.body).code).toBe('payload_too_large');

    const exe = await admin.upload(url, bytesOf('MZ'), 'setup.exe');
    expect(exe.statusCode).toBe(415);
    expect(errorOf(exe.body)).toMatchObject({
      code: 'unsupported_file_type',
      details: { allowed: [...UPLOAD_EXTENSIONS] },
    });

    expect((await admin.upload(url, new Uint8Array(0), 'empty.pdf')).statusCode).toBe(400);
    expect((await admin.upload(url, bytesOf('x'), null)).statusCode).toBe(400);
    const json = await admin.post(url, { file: 'x' });
    expect(json.statusCode).toBe(415);
    expect(errorOf(json.body).code).toBe('unsupported_media_type');
    const noCsrf = await admin.upload(url, bytesOf('x'), 'a.pdf', {
      headers: { 'x-csrf-token': null },
    });
    expect(noCsrf.statusCode).toBe(403);

    // A good file to an unknown policy: 404, and nothing reaches the store.
    const unknown = await admin.upload(
      `/api/policies/${UNKNOWN_ID}/versions`,
      bytesOf('x'),
      'a.pdf',
    );
    expect(unknown.statusCode).toBe(404);

    expect(h.store.keys()).toEqual([]);
    expect(h.db.select().from(policyVersion).all()).toEqual([]);

    // Exactly the limit is accepted.
    const max = await admin.upload(url, new Uint8Array(UPLOAD_MAX_BYTES), 'max.pdf');
    expect(max.statusCode, max.body).toBe(201);
    expect(policyResponseSchema.parse(max.json()).item.versions[0]?.size).toBe(UPLOAD_MAX_BYTES);
  });

  it('download', async () => {
    const { h, admin, item } = await world();
    const bytes = bytesOf('%PDF-1.7 the access policy\n');
    const uploaded = await admin.upload(
      `/api/policies/${item.id}/versions`,
      bytes,
      'Política 1.pdf',
    );
    expect(uploaded.statusCode).toBe(201);
    const fileUrl = `/api/policies/${item.id}/versions/1/file`;

    const download = await admin.get(fileUrl);
    expect(download.statusCode, download.body).toBe(200);
    expect(Buffer.compare(download.rawPayload, Buffer.from(bytes))).toBe(0);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="Politica 1.pdf"; filename*=UTF-8''Pol%C3%ADtica%201.pdf`,
    );
    expect(download.headers['cache-control']).toBe('no-store');

    expect((await admin.get(`/api/policies/${item.id}/versions/2/file`)).statusCode).toBe(404);
    expect((await admin.get(`/api/policies/${UNKNOWN_ID}/versions/1/file`)).statusCode).toBe(404);
    expect((await admin.get(`/api/policies/${item.id}/versions/abc/file`)).statusCode).toBe(404);
    expect((await admin.get(`/api/policies/${item.id}/versions/0/file`)).statusCode).toBe(404);
    expect((await h.client().get(fileUrl)).statusCode).toBe(401);

    h.store.corrupt(sha256(bytes));
    const corrupted = await admin.get(fileUrl);
    expect(corrupted.statusCode).toBe(500);
    expect(errorOf(corrupted.body)).toMatchObject({
      code: 'file_integrity_failed',
      message: FILE_INTEGRITY_MESSAGE,
    });
  });

  it('a missing stored file gives 500 file_integrity_failed, naming no path', async () => {
    const memory = createMemoryStore();
    let lose = false;
    const store: MemoryFileStore = {
      ...memory,
      get: (key, hash) =>
        lose
          ? Promise.reject(new StorageError('missing', `no file at /x/${key}`))
          : memory.get(key, hash),
    };
    const h = createHarness({ store });
    harnesses.push(h);
    const admin = await h.setupAdmin();
    const created = await admin.post('/api/policies', { title: 'Access', description: null });
    const { id } = policyResponseSchema.parse(created.json()).item;
    expect(
      (await admin.upload(`/api/policies/${id}/versions`, bytesOf('x'), 'a.pdf')).statusCode,
    ).toBe(201);
    lose = true;
    const response = await admin.get(`/api/policies/${id}/versions/1/file`);
    expect(response.statusCode).toBe(500);
    expect(errorOf(response.body)).toMatchObject({
      code: 'file_integrity_failed',
      message: FILE_INTEGRITY_MESSAGE,
    });
    expect(response.body).not.toContain('/x/');
  });
});
