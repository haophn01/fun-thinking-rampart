import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SSP_OUTLINE } from '../../ssp';
import { docxMedia, docxText, pngOf } from '../../ssp/testing/docx-text';
import { createMemoryStore, type MemoryFileStore } from '../../storage';
import {
  SSP_CONTENT_TYPE,
  SSP_MAX_EMBEDDED_IMAGES,
  diagramResponseSchema,
  errorEnvelopeSchema,
  evidenceItemResponseSchema,
  sspFileName,
  userResponseSchema,
  type DiagramLink,
  type EvidenceItem,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';
import { attachmentDisposition } from '../uploads/upload';

const URL = '/api/ssp/export';
// Late evening in California is already the next day in UTC: the file is dated by UTC.
const START = new Date('2026-11-24T23:30:00-08:00');
const TODAY = '2026-11-25';

const CONTRIBUTOR = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'a long enough password',
};

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** A memory store that records the SHA-256 of every file the app asks it for. */
function spyStore(): { store: MemoryFileStore; reads: string[] } {
  const inner = createMemoryStore();
  const reads: string[] = [];
  return {
    reads,
    store: {
      ...inner,
      get(key, sha256) {
        reads.push(sha256);
        return inner.get(key, sha256);
      },
    },
  };
}

async function world(store?: MemoryFileStore): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness({ start: START, ...(store ? { store } : {}) });
  harnesses.push(h);
  const admin = await h.setupAdmin();
  return { h, admin };
}

function ok(response: LightMyRequestResponse, status = 200): LightMyRequestResponse {
  expect(response.statusCode, response.body).toBe(status);
  return response;
}

function code(response: LightMyRequestResponse): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

function count(h: Harness, table: string): number {
  return h.handle.sqlite.prepare(`select count(*) from ${table}`).pluck().get() as number;
}

/** Every stored row the app's own writes touch, to show an export changes none of them. */
function snapshot(h: Harness): unknown {
  const all = (sql: string) => h.handle.sqlite.prepare(sql).all();
  return {
    audit: count(h, 'audit_event'),
    assessment: all('select * from assessment'),
    profile: all('select * from system_profile'),
    states: all('select * from requirement_state'),
    results: all('select * from objective_result'),
    poam: all('select * from poam_item'),
    revisions: all('select * from ssp_revision'),
    approvals: all('select * from ssp_approval'),
    diagrams: all('select * from diagram_link'),
  };
}

async function evidenceItem(client: Client, title: string, containsCui: boolean) {
  const response = ok(
    await client.post('/api/evidence', { title, description: null, containsCui }),
    201,
  );
  return evidenceItemResponseSchema.parse(response.json()).item;
}

async function fileItem(client: Client, title: string, bytes: Uint8Array, name: string) {
  const item = await evidenceItem(client, title, false);
  const response = ok(await client.upload(`/api/evidence/${item.id}/versions`, bytes, name), 201);
  return evidenceItemResponseSchema.parse(response.json()).item;
}

async function link(
  client: Client,
  item: EvidenceItem,
  kind: DiagramLink['kind'],
  caption: string,
): Promise<DiagramLink> {
  const response = ok(
    await client.post('/api/ssp/diagrams', { evidenceId: item.id, kind, caption, version: null }),
    201,
  );
  return diagramResponseSchema.parse(response.json()).diagram;
}

function shaOf(item: EvidenceItem): string {
  const [latest] = item.versions;
  if (latest?.kind !== 'file') throw new Error('not a file version');
  return latest.sha256;
}

/** The lines of the export, read back from its document.xml. */
async function exported(client: Client): Promise<{ lines: string[]; bytes: Uint8Array }> {
  const response = ok(await client.get(URL));
  const bytes = new Uint8Array(response.rawPayload);
  return { bytes, lines: docxText(bytes).split('\n') };
}

/** Each heading of the outline appears once, in order. */
function expectOutline(lines: readonly string[]) {
  const at = SSP_OUTLINE.map((heading) => lines.indexOf(heading));
  expect(
    at.every((i) => i >= 0),
    JSON.stringify(at),
  ).toBe(true);
  expect(at).toEqual(at.toSorted((a, b) => a - b));
  for (const heading of SSP_OUTLINE) {
    expect(
      lines.filter((line) => line === heading),
      heading,
    ).toHaveLength(1);
  }
}

describe('GET /api/ssp/export', () => {
  it('exports the docx', async () => {
    const { admin } = await world();
    ok(
      await admin.patch('/api/system-profile', {
        systemName: 'Enclave <One> & Co',
        systemIdentifier: 'ENCLAVE 01/prod',
        organizationName: 'Acme Defense',
      }),
    );
    ok(
      await admin.patch('/api/assessment/requirements/AC.L2-3.1.1', {
        implementationStatement: 'We enforce SSO for every account.\nAccess is reviewed monthly.',
      }),
    );

    const response = ok(await admin.get(URL));
    expect(response.headers['content-type']).toBe(SSP_CONTENT_TYPE);
    const fileName = sspFileName('ENCLAVE 01/prod', TODAY);
    expect(fileName).toBe(`SSP-ENCLAVE-01-prod-${TODAY}.docx`);
    expect(response.headers['content-disposition']).toBe(attachmentDisposition(fileName));
    expect(response.headers['cache-control']).toBe('no-store');

    const bytes = new Uint8Array(response.rawPayload);
    expect(response.headers['content-length']).toBe(String(bytes.length));
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe('PK');

    const lines = docxText(bytes).split('\n');
    expect(lines.slice(0, 3)).toEqual([
      'System Security Plan',
      'Enclave <One> & Co',
      `Generated by Rampart on ${TODAY}`,
    ]);
    expect(lines).toContain('Acme Defense');
    expect(lines).toContain('We enforce SSO for every account.');
    expect(lines).toContain('Access is reviewed monthly.');
    expect(lines).toContain('SPRS incomplete: CA.L2-3.12.4 must be Met');
    expect(lines.filter((line) => line === 'Status: Not yet assessed')).toHaveLength(110);
  });

  it('exports the v2 docx', async () => {
    const { store, reads } = spyStore();
    const { admin } = await world(store);
    ok(await admin.patch('/api/system-profile', { systemName: 'Enclave One' }));
    ok(await admin.patch('/api/ssp/profile', { securityOfficer: 'Sam Officer' }));
    ok(
      await admin.post('/api/ssp/roles', {
        title: 'Administrator',
        person: 'Ada Admin',
        userCount: 2,
        privileged: true,
      }),
      201,
    );
    ok(await admin.post('/api/ssp/assets', { name: 'File server', category: 'cui' }), 201);
    ok(
      await admin.post('/api/ssp/approvals', {
        name: 'Pat Owner',
        title: 'System owner',
        approvedOn: TODAY,
      }),
      201,
    );

    const png = await fileItem(admin, 'Network map', pngOf(1248, 600), 'network.png');
    const pdf = await fileItem(
      admin,
      'Data flow',
      new TextEncoder().encode('%PDF-1.7'),
      'flow.pdf',
    );
    const cui = await evidenceItem(admin, 'CUI flow', true);
    ok(
      await admin.post(`/api/evidence/${cui.id}/references`, { location: 'Safe 3', note: null }),
      201,
    );
    const pngLink = await link(admin, png, 'network', 'Boundary');
    const pdfLink = await link(admin, pdf, 'other', 'Flow chart');
    const cuiLink = await link(admin, cui, 'data_flow', 'CUI path');
    expect([pngLink.embeddable, pdfLink.embeddable, cuiLink.embeddable]).toEqual([
      true,
      false,
      false,
    ]);
    reads.length = 0;

    const { lines, bytes } = await exported(admin);
    expectOutline(lines);
    expect(lines).toContain('1.1 Roles and users');
    expect(lines).toContain('Sam Officer');
    expect(lines).toContain('Administrator');
    expect(lines).toContain('File server');
    expect(lines).toContain('Pat Owner, System owner');
    expect(lines).toContain(`Date: ${TODAY}`);

    // The PNG is embedded: one media part and its figure line.
    expect(docxMedia(bytes)).toHaveLength(1);
    expect(docxMedia(bytes)[0]).toMatch(/\.png$/);
    const figure = lines.filter((line) => line.startsWith('Figure '));
    expect(figure).toHaveLength(1);
    expect(figure[0]).toMatch(
      new RegExp(
        `^Figure 1\\. Boundary — Network diagram, Network map v1, network\\.png, SHA-256 ${shaOf(png)}, \\d{4}-\\d{2}-\\d{2}$`,
      ),
    );
    // The PDF and the CUI item are referenced.
    expect(lines).toContain(
      `Flow chart — Other diagram: Data flow v1, flow.pdf, SHA-256 ${shaOf(pdf)}, ${TODAY}`,
    );
    expect(lines).toContain(
      `CUI path — CUI data flow: CUI flow v1, contains CUI, kept at Safe 3, ${TODAY}`,
    );

    // Only the embeddable link's file was read.
    expect(reads).toEqual([shaOf(png)]);
  });

  it('unreadable image is referenced', async () => {
    const store = createMemoryStore();
    const { h, admin } = await world(store);
    const png = await fileItem(admin, 'Network map', pngOf(10, 10), 'network.png');
    const pngLink = await link(admin, png, 'network', 'Boundary');
    store.corrupt(shaOf(png));
    const logged = h.logs.length;

    const { lines, bytes } = await exported(admin);
    expect(docxMedia(bytes)).toEqual([]);
    expect(lines).toContain(
      `Boundary — Network diagram: Network map v1, network.png, SHA-256 ${shaOf(png)}, ${TODAY} (referenced: the image couldn't be read)`,
    );
    // One warning names the link, and no path or storage key.
    const warnings = h.logs.slice(logged).filter((entry) => entry.level === 40);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ linkId: pngLink.id });
    expect(JSON.stringify(warnings[0])).not.toContain(shaOf(png));
  });

  it('reads at most the embed limit', async () => {
    const { store, reads } = spyStore();
    const { admin } = await world(store);
    const items: EvidenceItem[] = [];
    for (let i = 0; i <= SSP_MAX_EMBEDDED_IMAGES; i += 1) {
      const item = await fileItem(
        admin,
        `Map ${String(i)}`,
        pngOf(2 + i, 2),
        `map-${String(i)}.png`,
      );
      await link(admin, item, 'network', `Map ${String(i).padStart(2, '0')}`);
      items.push(item);
    }
    reads.length = 0;
    const { lines, bytes } = await exported(admin);
    expect(reads).toHaveLength(SSP_MAX_EMBEDDED_IMAGES);
    expect(docxMedia(bytes)).toHaveLength(SSP_MAX_EMBEDDED_IMAGES);
    expect(
      lines.filter((line) =>
        line.endsWith(
          `(referenced: the SSP embeds at most ${String(SSP_MAX_EMBEDDED_IMAGES)} images)`,
        ),
      ),
    ).toHaveLength(1);
  });

  it('access and no side effects', async () => {
    const { h, admin } = await world();
    ok(await admin.patch('/api/system-profile', { systemName: 'Enclave One' }));

    // Signed out.
    const signedOut = await h.client().get(URL);
    expect(signedOut.statusCode).toBe(401);
    expect(code(signedOut)).toBe('unauthenticated');

    // A contributor exports, and the export writes nothing and audits nothing.
    const created = userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
    expect(created.user.role).toBe('contributor');
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
    const png = await fileItem(admin, 'Network map', pngOf(10, 10), 'network.png');
    await link(admin, png, 'network', 'Boundary');
    const before = snapshot(h);
    const response = ok(await carl.get(URL));
    expect(response.headers['content-type']).toBe(SSP_CONTENT_TYPE);
    // No identifier saved: the file is named for the system.
    expect(response.headers['content-disposition']).toBe(
      attachmentDisposition(`SSP-system-${TODAY}.docx`),
    );
    const { lines } = await exported(admin);
    expect(lines).toContain('No changes recorded.');
    expect(snapshot(h)).toEqual(before);

    // No assessment: 404.
    h.handle.sqlite.pragma('foreign_keys = OFF');
    h.handle.sqlite.exec('DELETE FROM assessment');
    h.handle.sqlite.pragma('foreign_keys = ON');
    const missing = await admin.get(URL);
    expect(missing.statusCode).toBe(404);
    expect(code(missing)).toBe('not_found');
  });
});
