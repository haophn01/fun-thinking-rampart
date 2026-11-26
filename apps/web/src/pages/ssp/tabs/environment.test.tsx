import {
  DEFAULT_CATEGORIZATION,
  type DiagramLink,
  type EvidenceItem,
  type SspProfile,
} from '@rampart/api/contract';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ME, apiError, json, renderSsp, stubApi, type Routes } from '../kit/testing';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const AT = '2026-11-24T10:00:00.000Z';

const PROFILE: SspProfile = {
  categorization: DEFAULT_CATEGORIZATION,
  securityOfficer: null,
  securityOfficerEmail: null,
  organizationAddress: null,
  organizationPhone: null,
  cuiCategories: null,
  cuiLocations: null,
  cuiEntryExit: null,
  topologyNarrative: null,
  dataFlowNarrative: null,
  inventoryReference: null,
  maintenanceStatement: null,
  reviewCadenceMonths: 12,
  nextReviewDate: null,
  updatedAt: null,
  updatedBy: null,
};

const SHA = 'a'.repeat(64);

function fileVersion(version: number, fileName: string, size = 2048) {
  return {
    kind: 'file' as const,
    version,
    fileName,
    size,
    sha256: SHA,
    createdAt: AT,
    createdBy: ME,
  };
}

function item(
  id: string,
  title: string,
  containsCui: boolean,
  versions: EvidenceItem['versions'],
): EvidenceItem {
  return {
    id,
    title,
    description: null,
    containsCui,
    objectiveIds: [],
    versions,
    createdAt: AT,
    createdBy: ME,
    updatedAt: AT,
  };
}

const NET = item('11111111-1111-4111-8111-111111111111', 'Network map', false, [
  fileVersion(2, 'net-v2.png'),
  fileVersion(1, 'net-v1.png'),
]);
const PDF = item('22222222-2222-4222-8222-222222222222', 'Flow PDF', false, [
  fileVersion(1, 'flow.pdf'),
]);
const CUI = item('33333333-3333-4333-8333-333333333333', 'Enclave plan', true, [
  {
    kind: 'reference',
    version: 1,
    location: 'Vault 7',
    note: null,
    createdAt: AT,
    createdBy: ME,
  },
]);
const EMPTY = item('44444444-4444-4444-8444-444444444444', 'Draft sketch', false, []);

function link(partial: Partial<DiagramLink> & Pick<DiagramLink, 'id' | 'caption'>): DiagramLink {
  return {
    kind: 'network',
    evidence: { id: NET.id, title: NET.title, containsCui: false },
    version: null,
    resolved: {
      version: 2,
      kind: 'file',
      fileName: 'net-v2.png',
      size: 2048,
      sha256: SHA,
      location: null,
      createdAt: AT,
    },
    embeddable: true,
    createdAt: AT,
    updatedAt: AT,
    ...partial,
  };
}

const LISTS = {
  profile: 'GET /api/ssp/profile',
  patchProfile: 'PATCH /api/ssp/profile',
  evidence: 'GET /api/evidence',
  diagrams: 'GET /api/ssp/diagrams',
  create: 'POST /api/ssp/diagrams',
};

function baseRoutes(
  diagrams: () => DiagramLink[],
  evidence: EvidenceItem[] = [NET, PDF, CUI, EMPTY],
  extra: Routes = {},
): Routes {
  return {
    [LISTS.profile]: () => json(200, { profile: PROFILE }),
    [LISTS.evidence]: () => json(200, { items: evidence }),
    [LISTS.diagrams]: () => json(200, { diagrams: diagrams() }),
    ...extra,
  };
}

function rowOf(caption: string): HTMLElement {
  const row = screen.getByText(caption).closest('tr');
  if (row === null) throw new Error(`no row for ${caption}`);
  return row;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Environment tab', () => {
  it('narrative forms', async () => {
    const api = stubApi({
      ...baseRoutes(() => []),
      [LISTS.patchProfile]: (call) =>
        json(200, { profile: { ...PROFILE, ...(call.body as object) } }),
    });
    const user = userEvent.setup();
    renderSsp('environment');

    const cui = await screen.findByRole('form', { name: 'CUI description' });
    const env = screen.getByRole('form', { name: 'System environment' });
    expect(within(cui).getByLabelText('CUI categories (CUI Registry)')).toBeInTheDocument();
    expect(
      within(cui).getByLabelText('Where CUI is stored, processed or transmitted'),
    ).toBeInTheDocument();
    expect(within(cui).getByLabelText('How CUI enters and leaves the system')).toBeInTheDocument();
    expect(within(cui).queryByLabelText('Network topology')).toBeNull();
    for (const label of [
      'Network topology',
      'CUI data flow',
      'Hardware and software inventory',
      'Maintenance and ownership',
    ]) {
      expect(within(env).getByLabelText(label)).toBeInTheDocument();
    }
    expect(within(env).queryByLabelText('CUI categories (CUI Registry)')).toBeNull();

    await user.type(within(cui).getByLabelText('CUI categories (CUI Registry)'), 'CTI');
    await user.click(within(cui).getByRole('button', { name: 'Save' }));
    const first = await api.waitForCall(LISTS.patchProfile);
    expect(first[0]?.body).toEqual({ cuiCategories: 'CTI' });

    await user.type(within(env).getByLabelText('Network topology'), 'Flat LAN');
    await user.click(within(env).getByRole('button', { name: 'Save' }));
    const both = await api.waitForCall(LISTS.patchProfile, 2);
    expect(both[1]?.body).toEqual({ topologyNarrative: 'Flat LAN' });
  });

  it('diagram rows', async () => {
    const diagrams = [
      link({ id: 'd1', caption: 'Office network' }),
      link({
        id: 'd2',
        caption: 'Flow sheet',
        kind: 'data_flow',
        evidence: { id: PDF.id, title: PDF.title, containsCui: false },
        version: 1,
        resolved: {
          version: 1,
          kind: 'file',
          fileName: 'flow.pdf',
          size: 5000,
          sha256: SHA,
          location: null,
          createdAt: AT,
        },
        embeddable: false,
      }),
      link({
        id: 'd3',
        caption: 'Enclave layout',
        kind: 'other',
        evidence: { id: CUI.id, title: CUI.title, containsCui: true },
        resolved: {
          version: 1,
          kind: 'reference',
          fileName: null,
          size: null,
          sha256: null,
          location: 'Vault 7',
          createdAt: AT,
        },
        embeddable: false,
      }),
      link({
        id: 'd4',
        caption: 'Sketch',
        kind: 'other',
        evidence: { id: EMPTY.id, title: EMPTY.title, containsCui: false },
        resolved: null,
        embeddable: false,
      }),
    ];
    stubApi(baseRoutes(() => diagrams));
    renderSsp('environment');
    await screen.findByText('Office network');

    const net = within(rowOf('Office network'));
    expect(net.getByText('Embedded image')).toBeInTheDocument();
    expect(net.getByText('Network diagram')).toBeInTheDocument();
    expect(net.getByText('Network map')).toBeInTheDocument();
    expect(net.getByText('Newest (v2)')).toBeInTheDocument();
    expect(net.getByText(/net-v2\.png/)).toBeInTheDocument();
    expect(net.getByText(/2\.0 KiB/)).toBeInTheDocument();

    const pdf = within(rowOf('Flow sheet'));
    expect(pdf.getByText('Referenced')).toBeInTheDocument();
    expect(pdf.getByText('v1')).toBeInTheDocument();
    expect(pdf.getByText('CUI data flow')).toBeInTheDocument();

    const cui = within(rowOf('Enclave layout'));
    expect(cui.getByText('Referenced — contains CUI')).toBeInTheDocument();
    expect(cui.getByText('Reference: Vault 7')).toBeInTheDocument();

    const none = within(rowOf('Sketch'));
    expect(none.getByText('No version yet')).toBeInTheDocument();
    expect(none.getByText('Referenced')).toBeInTheDocument();
  });

  it('link diagram', async () => {
    let stored: DiagramLink[] = [];
    const api = stubApi(
      baseRoutes(() => stored, undefined, {
        [LISTS.create]: (call) => {
          const body = call.body as { caption: string; version: number | null };
          stored = [...stored, link({ id: `n${String(stored.length)}`, caption: body.caption })];
          return json(201, { diagram: stored[stored.length - 1] });
        },
      }),
    );
    const user = userEvent.setup();
    renderSsp('environment');
    const form = await screen.findByRole('form', { name: 'Link a diagram' });

    const evidence = within(form).getByLabelText('Evidence item');
    expect(within(form).getByRole('option', { name: 'Enclave plan (contains CUI)' })).toBeVisible();
    await user.selectOptions(evidence, NET.id);
    await user.selectOptions(within(form).getByLabelText('Kind'), 'data_flow');
    await user.type(within(form).getByLabelText('Caption'), 'Office network');
    // Default: always the newest.
    await user.click(within(form).getByRole('button', { name: 'Link diagram' }));
    let calls = await api.waitForCall(LISTS.create);
    expect(calls[0]?.body).toEqual({
      evidenceId: NET.id,
      kind: 'data_flow',
      caption: 'Office network',
      version: null,
    });
    // The list reloads and shows the new link.
    await screen.findByText('Office network');
    expect(api.sent(LISTS.diagrams).length).toBeGreaterThanOrEqual(2);

    // Pin a version.
    const again = screen.getByRole('form', { name: 'Link a diagram' });
    await user.selectOptions(within(again).getByLabelText('Evidence item'), NET.id);
    const version = within(again).getByLabelText('Version');
    expect(
      within(version)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Always the newest', 'v2', 'v1']);
    await user.selectOptions(version, '1');
    await user.type(within(again).getByLabelText('Caption'), 'Pinned');
    await user.click(within(again).getByRole('button', { name: 'Link diagram' }));
    calls = await api.waitForCall(LISTS.create, 2);
    expect(calls[1]?.body).toEqual({
      evidenceId: NET.id,
      kind: 'network',
      caption: 'Pinned',
      version: 1,
    });
  });

  it('link validation', async () => {
    const api = stubApi(
      baseRoutes(() => [], undefined, {
        [LISTS.create]: () =>
          apiError(400, 'validation_failed', 'Invalid request', [
            { path: ['version'], message: 'That version does not exist' },
          ]),
      }),
    );
    const user = userEvent.setup();
    renderSsp('environment');
    const form = await screen.findByRole('form', { name: 'Link a diagram' });

    expect(screen.queryByText(/never embed it/)).toBeNull();
    await user.selectOptions(within(form).getByLabelText('Evidence item'), CUI.id);
    expect(
      screen.getByText('This item contains CUI. The SSP will reference it and never embed it.'),
    ).toBeInTheDocument();

    // A blank caption sends nothing.
    await user.type(within(form).getByLabelText('Caption'), '   ');
    await user.click(within(form).getByRole('button', { name: 'Link diagram' }));
    expect(await within(form).findByText('Enter a caption')).toBeInTheDocument();
    expect(api.sent(LISTS.create)).toHaveLength(0);

    // No item chosen sends nothing either.
    await user.selectOptions(within(form).getByLabelText('Evidence item'), '');
    await user.type(within(form).getByLabelText('Caption'), 'x');
    await user.click(within(form).getByRole('button', { name: 'Link diagram' }));
    expect(await within(form).findByText('Select the evidence item to link')).toBeInTheDocument();
    expect(api.sent(LISTS.create)).toHaveLength(0);

    // A 400 on version shows on the Version field.
    await user.selectOptions(within(form).getByLabelText('Evidence item'), NET.id);
    await user.click(within(form).getByRole('button', { name: 'Link diagram' }));
    await api.waitForCall(LISTS.create);
    const versionField = within(form).getByLabelText('Version');
    await waitFor(() => {
      expect(versionField).toHaveAccessibleDescription('That version does not exist');
    });
  });

  it('no evidence', async () => {
    stubApi(baseRoutes(() => [], []));
    renderSsp('environment');
    expect(await screen.findByText('Add the diagram on the Evidence page first.')).toBeVisible();
    expect(screen.getByRole('link', { name: /Evidence page/ })).toHaveAttribute(
      'href',
      '/evidence',
    );
    expect(screen.queryByRole('form', { name: 'Link a diagram' })).toBeNull();
  });

  it('edit and remove', async () => {
    let stored = [link({ id: 'd1', caption: 'Office network' })];
    const api = stubApi(
      baseRoutes(() => stored, undefined, {
        'PATCH /api/ssp/diagrams/d1': (call) => {
          stored = [{ ...stored[0], ...(call.body as object) } as DiagramLink];
          return json(200, { diagram: stored[0] });
        },
        'DELETE /api/ssp/diagrams/d1': () => {
          stored = [];
          return json(204);
        },
      }),
    );
    const user = userEvent.setup();
    renderSsp('environment');
    await screen.findByText('Office network');

    await user.click(within(rowOf('Office network')).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit diagram' });
    // The evidence item can't change: it is shown, not chosen.
    expect(within(form).queryByLabelText('Evidence item')).toBeNull();
    expect(within(form).getByLabelText('Caption')).toHaveValue('Office network');
    // Unchanged: Save is disabled.
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(within(form).getByLabelText('Caption'));
    await user.type(within(form).getByLabelText('Caption'), 'HQ network');
    await user.selectOptions(within(form).getByLabelText('Version'), '1');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const patches = await api.waitForCall('PATCH /api/ssp/diagrams/d1');
    expect(patches[0]?.body).toEqual({ caption: 'HQ network', version: 1 });
    expect(patches[0]?.body).not.toHaveProperty('evidenceId');
    await screen.findByText('HQ network');
    expect(screen.queryByRole('form', { name: 'Edit diagram' })).toBeNull();

    // Remove needs Confirm.
    const row = within(rowOf('HQ network'));
    await user.click(row.getByRole('button', { name: 'Remove' }));
    expect(api.sent('DELETE /api/ssp/diagrams/d1')).toHaveLength(0);
    await user.click(row.getByRole('button', { name: 'Confirm remove' }));
    await api.waitForCall('DELETE /api/ssp/diagrams/d1');
    await waitFor(() => {
      expect(screen.queryByText('HQ network')).toBeNull();
    });
  });

  it('shows its own error when a remove fails', async () => {
    const stored = [link({ id: 'd1', caption: 'Office network' })];
    const api = stubApi(
      baseRoutes(() => stored, undefined, {
        'DELETE /api/ssp/diagrams/d1': () => apiError(500, 'internal_error'),
      }),
    );
    const user = userEvent.setup();
    renderSsp('environment');
    await screen.findByText('Office network');
    const row = within(rowOf('Office network'));
    await user.click(row.getByRole('button', { name: 'Remove' }));
    await user.click(row.getByRole('button', { name: 'Confirm remove' }));
    await api.waitForCall('DELETE /api/ssp/diagrams/d1');
    expect(await screen.findByText("Couldn't remove the diagram.")).toBeInTheDocument();
    expect(screen.getByText('Office network')).toBeInTheDocument();
  });
});
