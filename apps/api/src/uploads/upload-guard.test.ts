// The upload content guard as users meet it: the evidence and policy upload routes refuse files
// whose bytes aren't what their name says, store nothing when they do, and keep the sanitized
// name everywhere. Files stored before the guard keep working.
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UPLOAD_EXTENSIONS,
  auditPageSchema,
  diagramResponseSchema,
  errorEnvelopeSchema,
  evidenceItemResponseSchema,
  evidenceListSchema,
  fileRefusedMessage,
  policyResponseSchema,
  type AuditPage,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';
import {
  fakeExe,
  sampleDocx,
  samplePdf,
  samplePng,
  sampleXlsx,
  zipBombDocx,
} from './testing/samples';

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

/** A GIF: a picture, but neither an allowed type nor one the export can embed. */
const GIF_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b,
]);

interface Target {
  name: 'evidence' | 'policies';
  entityType: string;
  /** Creates a row that takes file uploads and returns its id. */
  create(client: Client): Promise<string>;
  /** The row's file versions, newest first, as the api shows them. */
  versions(response: LightMyRequestResponse): { fileName?: string; version: number }[];
}

const TARGETS: Target[] = [
  {
    name: 'evidence',
    entityType: 'evidence_item',
    async create(client) {
      const response = await client.post('/api/evidence', {
        title: 'Firewall export',
        description: null,
        containsCui: false,
      });
      expect(response.statusCode, response.body).toBe(201);
      return evidenceItemResponseSchema.parse(response.json()).item.id;
    },
    versions: (response) => evidenceItemResponseSchema.parse(response.json()).item.versions,
  },
  {
    name: 'policies',
    entityType: 'policy',
    async create(client) {
      const response = await client.post('/api/policies', {
        title: 'Access control policy',
        description: null,
      });
      expect(response.statusCode, response.body).toBe(201);
      return policyResponseSchema.parse(response.json()).item.id;
    },
    versions: (response) => policyResponseSchema.parse(response.json()).item.versions,
  },
];

const versionsUrl = (target: Target, id: string) => `/api/${target.name}/${id}/versions`;

function errorOf(response: LightMyRequestResponse) {
  return errorEnvelopeSchema.parse(response.json()).error;
}

async function events(client: Client, target: Target, id: string): Promise<AuditPage['events']> {
  const response = await client.get(`/api/audit?entityType=${target.entityType}&entityId=${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return auditPageSchema.parse(response.json()).events;
}

describe.each(TARGETS)('uploads to $name', (target) => {
  it('refuses a renamed EXE, an SVG, an HTML file and a zip-bomb docx, and accepts real files', async () => {
    const { admin } = await world();
    const id = await target.create(admin);

    const exe = await admin.upload(versionsUrl(target, id), fakeExe(), 'report.pdf');
    expect(exe.statusCode).toBe(415);
    expect(errorOf(exe)).toMatchObject({
      code: 'file_refused',
      message: "This file's contents aren't a real PDF file. It looks like a program.",
      details: { reason: 'content_mismatch', extension: '.pdf', detected: 'executable' },
    });

    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    for (const [bytes, name] of [
      [bytesOf(svg), 'a.svg'],
      [bytesOf('<!doctype html><title>x</title>'), 'page.html'],
    ] as const) {
      const response = await admin.upload(versionsUrl(target, id), bytes, name);
      expect(response.statusCode, name).toBe(415);
      expect(errorOf(response), name).toMatchObject({
        code: 'unsupported_file_type',
        message: "This file type can't be uploaded",
        details: { allowed: [...UPLOAD_EXTENSIONS] },
      });
    }

    // The same markup renamed to .txt is judged by its content.
    const renamedSvg = await admin.upload(versionsUrl(target, id), bytesOf(svg), 'a.txt');
    expect(errorOf(renamedSvg)).toMatchObject({
      code: 'file_refused',
      message: fileRefusedMessage('markup_in_text', '.txt'),
      details: { reason: 'markup_in_text', extension: '.txt' },
    });

    const bomb = await admin.upload(versionsUrl(target, id), zipBombDocx(), 'notes.docx');
    expect(bomb.statusCode).toBe(415);
    expect(errorOf(bomb)).toMatchObject({
      code: 'file_refused',
      message: 'This file expands to more than 100 times its size.',
      details: { reason: 'zip_ratio', extension: '.docx' },
    });

    const real: [Uint8Array, string][] = [
      [samplePdf(), 'policy.pdf'],
      [samplePng(), 'network.png'],
      [sampleDocx(), 'procedure.docx'],
      [sampleXlsx(), 'inventory.xlsx'],
      [bytesOf('host,ip\nfw1,10.0.0.1\n'), 'hosts.csv'],
    ];
    for (const [bytes, name] of real) {
      const response = await admin.upload(versionsUrl(target, id), bytes, name);
      expect(response.statusCode, `${name}: ${response.body}`).toBe(201);
    }
    const last = await admin.upload(versionsUrl(target, id), sampleXlsx(), 'inventory v2.xlsx');
    expect(target.versions(last).map((v) => v.fileName)).toEqual([
      'inventory v2.xlsx',
      'hosts.csv',
      'inventory.xlsx',
      'procedure.docx',
      'network.png',
      'policy.pdf',
    ]);
  });

  it('nothing is stored or audited on a refusal', async () => {
    const { h, admin } = await world();
    const id = await target.create(admin);
    const before = await events(admin, target, id);

    for (const [bytes, name] of [
      [fakeExe(), 'report.pdf'],
      [zipBombDocx(), 'bomb.docx'],
      [bytesOf('\u0000\u0001binary'), 'notes.txt'],
      [samplePng(), 'photo.jpg'],
    ] as const) {
      const response = await admin.upload(versionsUrl(target, id), bytes, name);
      expect(response.statusCode, name).toBe(415);
      expect(errorOf(response).code, name).toBe('file_refused');
    }

    expect(h.store.keys()).toEqual([]);
    expect(await events(admin, target, id)).toEqual(before);
    const ok = await admin.upload(versionsUrl(target, id), samplePdf(), 'real.pdf');
    expect(target.versions(ok).map((v) => v.version)).toEqual([1]);
    expect(h.store.keys()).toHaveLength(1);
  });

  it('sanitized names are stored and returned', async () => {
    const { admin } = await world();
    const id = await target.create(admin);
    const cases: [sent: string, stored: string, bytes: Uint8Array][] = [
      ['a\u202efdp.txt', 'afdp.txt', bytesOf('first notes\n')],
      ['CON.txt', '_CON.txt', bytesOf('second notes\n')],
    ];
    for (const [index, [sent, stored, bytes]] of cases.entries()) {
      const response = await admin.upload(versionsUrl(target, id), bytes, sent);
      expect(response.statusCode, response.body).toBe(201);
      const [newest] = target.versions(response);
      expect(newest).toMatchObject({ version: index + 1, fileName: stored });

      const file = await admin.get(`${versionsUrl(target, id)}/${String(index + 1)}/file`);
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-disposition']).toBe(
        `attachment; filename="${stored}"; filename*=UTF-8''${stored}`,
      );
      expect(file.rawPayload.equals(Buffer.from(bytes))).toBe(true);
    }

    const added = (await events(admin, target, id)).filter((e) =>
      e.action.endsWith('.version_added'),
    );
    expect(added.map((e) => (e.after as { fileName: string }).fileName).sort()).toEqual([
      '_CON.txt',
      'afdp.txt',
    ]);
  });
});

describe('stored files from before the guard', () => {
  it('stored files from before the guard still list and download', async () => {
    const { h, admin } = await world();
    const evidence = TARGETS.find((target) => target.name === 'evidence');
    if (evidence === undefined) throw new Error('no evidence target');
    const id = await evidence.create(admin);
    const version = await h.seedFileVersion({
      evidenceItemId: id,
      bytes: GIF_BYTES,
      fileName: 'map.png',
    });
    expect(version).toBe(1);

    const listed = evidenceListSchema.parse((await admin.get('/api/evidence')).json()).items;
    expect(listed.find((item) => item.id === id)?.versions).toEqual([
      expect.objectContaining({ kind: 'file', version: 1, fileName: 'map.png', size: 14 }),
    ]);

    const file = await admin.get(`/api/evidence/${id}/versions/1/file`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(Buffer.from(GIF_BYTES))).toBe(true);

    const linked = await admin.post('/api/ssp/diagrams', {
      evidenceId: id,
      kind: 'network',
      caption: 'Old map',
      version: null,
    });
    expect(linked.statusCode, linked.body).toBe(201);
    const diagram = diagramResponseSchema.parse(linked.json()).diagram;
    expect(diagram.resolved).toMatchObject({ kind: 'file', fileName: 'map.png' });
    expect(diagram.embeddable).toBe(false);

    // The same bytes uploaded now are refused, and the stored version is untouched.
    const again = await admin.upload(`/api/evidence/${id}/versions`, GIF_BYTES, 'map.png');
    expect(again.statusCode).toBe(415);
    expect(errorOf(again)).toMatchObject({
      code: 'file_refused',
      message: "This file's contents aren't a real PNG file.",
      details: { reason: 'content_mismatch', extension: '.png', detected: 'unknown' },
    });
    const still = await admin.get(`/api/evidence/${id}/versions/1/file`);
    expect(still.rawPayload.equals(Buffer.from(GIF_BYTES))).toBe(true);
  });
});
