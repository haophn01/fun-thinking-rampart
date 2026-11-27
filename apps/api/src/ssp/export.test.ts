import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SSP_OUTLINE, exportSsp } from '../../ssp';
import { docxMedia, docxText, pngOf } from '../../ssp/testing/docx-text';
import { createMemoryStore, type MemoryFileStore } from '../../storage';
import {
  SSP_CONTENT_TYPE,
  SSP_MAX_EMBEDDED_IMAGES,
  diagramResponseSchema,
  documentControlSchema,
  errorEnvelopeSchema,
  evidenceItemResponseSchema,
  evidenceListSchema,
  sspFileName,
  userResponseSchema,
  type DiagramLink,
  type EvidenceItem,
  type SspRevision,
} from '../contract';
import { ADMIN, createHarness, type Client, type Harness } from '../testing/harness';
import { attachmentDisposition } from '../uploads/upload';

// The real export, wrapped so one test can make the render fail: no stored data makes it throw.
vi.mock('../../ssp', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../ssp')>();
  return { ...real, exportSsp: vi.fn(real.exportSsp) };
});

/** GIF bytes: a picture the export can't embed, whatever its name says. */
const GIF_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b,
]);

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
  vi.mocked(exportSsp).mockClear();
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

async function world(
  store?: MemoryFileStore,
  start = START,
): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness({ start, ...(store ? { store } : {}) });
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

/**
 * An evidence item holding a file stored before the upload guard (the guard refuses these bytes
 * now): the version is seeded straight into the store and the DB.
 */
async function legacyFileItem(
  h: Harness,
  client: Client,
  title: string,
  bytes: Uint8Array,
  name: string,
) {
  const item = await evidenceItem(client, title, false);
  await h.seedFileVersion({ evidenceItemId: item.id, bytes, fileName: name });
  const listed = evidenceListSchema.parse(ok(await client.get('/api/evidence')).json()).items;
  const seeded = listed.find((row) => row.id === item.id);
  if (seeded === undefined) throw new Error(`evidence item ${item.id} is not listed`);
  return seeded;
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

/** The stored revisions, through the route the web reads. */
async function revisionsOf(client: Client): Promise<SspRevision[]> {
  return documentControlSchema.parse(ok(await client.get('/api/ssp/document-control')).json())
    .revisions;
}

interface RevisionEvent {
  action: string;
  entityId: string;
  after: unknown;
}

function revisionEvents(h: Harness): RevisionEvent[] {
  const rows = h.handle.sqlite
    .prepare(
      `select action, entity_id as entityId, after from audit_event
       where entity_type = 'ssp_revision' order by id`,
    )
    .all() as { action: string; entityId: string; after: string }[];
  return rows.map((row) => ({ ...row, after: JSON.parse(row.after) as unknown }));
}

/** The rows of the record-of-changes table, as [date, description, made by]. */
function changeRows(lines: readonly string[]): string[][] {
  const section = lines.slice(lines.indexOf('4. Record of changes'), lines.indexOf('Approvals'));
  const header = section.indexOf('Date');
  expect(section.slice(header, header + 3)).toEqual(['Date', 'Description', 'Made by']);
  const cells = section.slice(header + 3);
  const rows: string[][] = [];
  for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3));
  return rows;
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

  it('a GIF named .png is referenced and takes no embed slot', async () => {
    const { store, reads } = spyStore();
    const { h, admin } = await world(store);
    const fake = await legacyFileItem(h, admin, 'Old map', GIF_BYTES, 'fake.png');
    const fakeLink = await link(admin, fake, 'network', 'Map 00 fake');
    expect(fakeLink.embeddable).toBe(false);
    for (let i = 0; i < SSP_MAX_EMBEDDED_IMAGES; i += 1) {
      const item = await fileItem(
        admin,
        `Map ${String(i)}`,
        pngOf(2 + i, 2),
        `map-${String(i)}.png`,
      );
      await link(admin, item, 'network', `Map ${String(i + 1).padStart(2, '0')}`);
    }
    reads.length = 0;
    const { lines, bytes } = await exported(admin);
    // Every real PNG is embedded: the GIF didn't take a slot.
    expect(docxMedia(bytes)).toHaveLength(SSP_MAX_EMBEDDED_IMAGES);
    expect(lines).toContain(
      `Map 00 fake — Network diagram: Old map v1, fake.png, SHA-256 ${shaOf(fake)}, ${TODAY}`,
    );
    expect(lines.filter((line) => line.includes('(referenced:'))).toEqual([]);
    expect(reads).not.toContain(shaOf(fake));
  });

  it('export records a revision', async () => {
    // Just before UTC midnight: still the 25th in UTC, mid-afternoon in California.
    const { h, admin } = await world(undefined, new Date(`${TODAY}T23:59:00.000Z`));
    ok(await admin.patch('/api/system-profile', { systemIdentifier: 'ENCLAVE-01' }));
    h.clock.set(new Date(`${TODAY}T23:59:59.999Z`));
    const fileName = sspFileName('ENCLAVE-01', TODAY);
    const eventsBefore = revisionEvents(h).length;

    const response = ok(await admin.get(URL));
    expect(response.headers['content-disposition']).toBe(attachmentDisposition(fileName));

    const revisions = await revisionsOf(admin);
    expect(revisions).toHaveLength(1);
    const [revision] = revisions;
    expect(revision).toMatchObject({
      kind: 'export',
      date: TODAY,
      description: `Exported as ${fileName}`,
      madeBy: ADMIN.displayName,
      createdAt: `${TODAY}T23:59:59.999Z`,
    });
    expect(revisionEvents(h).slice(eventsBefore)).toEqual([
      {
        action: 'ssp_revision.created',
        entityId: revision?.id,
        after: {
          kind: 'export',
          date: TODAY,
          description: `Exported as ${fileName}`,
          madeBy: ADMIN.displayName,
        },
      },
    ]);

    // The record of changes the file prints ends with the entry that was stored.
    const lines = docxText(new Uint8Array(response.rawPayload)).split('\n');
    expect(changeRows(lines)).toEqual([[TODAY, `Exported as ${fileName}`, ADMIN.displayName]]);
    expect(lines).not.toContain('No changes recorded.');
  });

  it('repeats and roles', async () => {
    const { h, admin } = await world();
    ok(
      await admin.post('/api/ssp/revisions', {
        date: '2026-11-01',
        description: 'First draft',
        madeBy: 'Pat Owner',
      }),
      201,
    );
    const created = userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
    expect(created.user.role).toBe('contributor');
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
    // No identifier saved: the file is named for the system.
    const fileName = `SSP-system-${TODAY}.docx`;
    const entry = (madeBy: string) => [TODAY, `Exported as ${fileName}`, madeBy];
    const draft = ['2026-11-01', 'First draft', 'Pat Owner'];

    const first = await exported(admin);
    expect(changeRows(first.lines)).toEqual([draft, entry(ADMIN.displayName)]);
    h.clock.advance(1000);
    const second = await exported(admin);
    expect(changeRows(second.lines)).toEqual([
      draft,
      entry(ADMIN.displayName),
      entry(ADMIN.displayName),
    ]);
    h.clock.advance(1000);
    // A contributor's export is made by the contributor.
    const third = await exported(carl);
    expect(changeRows(third.lines).at(-1)).toEqual(entry(CONTRIBUTOR.displayName));

    const revisions = await revisionsOf(admin);
    expect(revisions.map((r) => [r.kind, r.date, r.description, r.madeBy])).toEqual([
      ['manual', ...draft],
      ['export', ...entry(ADMIN.displayName)],
      ['export', ...entry(ADMIN.displayName)],
      ['export', ...entry(CONTRIBUTOR.displayName)],
    ]);
    // Each write added exactly one event, for its own entry.
    expect(revisionEvents(h).map((e) => e.entityId)).toEqual(revisions.map((r) => r.id));
    // The printed table is what the api stores, row for row.
    expect(changeRows(third.lines)).toEqual(
      revisions.map((r) => [r.date, r.description, r.madeBy]),
    );
  });

  it('failures write nothing', async () => {
    const { h, admin } = await world();
    ok(await admin.patch('/api/system-profile', { systemName: 'Enclave One' }));
    const png = await fileItem(admin, 'Network map', pngOf(10, 10), 'network.png');
    await link(admin, png, 'network', 'Boundary');
    const before = snapshot(h);

    // Signed out.
    const signedOut = await h.client().get(URL);
    expect(signedOut.statusCode).toBe(401);
    expect(code(signedOut)).toBe('unauthenticated');
    expect(snapshot(h)).toEqual(before);

    // The render throws: 500, and no revision or event.
    vi.mocked(exportSsp).mockRejectedValueOnce(new Error('render failed'));
    const failed = await admin.get(URL);
    expect(failed.statusCode).toBe(500);
    expect(code(failed)).toBe('internal_error');
    expect(vi.mocked(exportSsp)).toHaveBeenCalledTimes(1);
    expect(snapshot(h)).toEqual(before);
    expect(await revisionsOf(admin)).toEqual([]);

    // No assessment: 404, and nothing written.
    h.handle.sqlite.pragma('foreign_keys = OFF');
    h.handle.sqlite.exec('DELETE FROM assessment');
    h.handle.sqlite.pragma('foreign_keys = ON');
    const emptied = snapshot(h);
    const missing = await admin.get(URL);
    expect(missing.statusCode).toBe(404);
    expect(code(missing)).toBe('not_found');
    expect(snapshot(h)).toEqual(emptied);
  });
});
