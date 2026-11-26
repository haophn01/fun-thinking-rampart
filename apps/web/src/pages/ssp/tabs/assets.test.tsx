import { ASSET_CATEGORIES, ASSET_CATEGORY_LABELS, type Asset } from '@rampart/api/contract';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, renderSsp, stubApi, type Routes } from '../kit/testing';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const LIST = 'GET /api/ssp/assets';
const CREATE = 'POST /api/ssp/assets';

function asset(over: Partial<Asset> & Pick<Asset, 'id' | 'name' | 'category'>): Asset {
  return {
    assetType: null,
    owner: null,
    location: null,
    treatment: null,
    outOfScopeJustification: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const LAPTOPS = asset({
  id: 'a-1',
  name: 'Laptop fleet',
  category: 'cui',
  assetType: 'Endpoint',
  owner: 'IT',
  location: 'HQ',
  treatment: 'Encrypted disks',
});
const SIEM = asset({ id: 'a-2', name: 'SIEM', category: 'spa', owner: 'SecOps' });
const GUEST = asset({
  id: 'a-3',
  name: 'Guest Wi-Fi',
  category: 'out_of_scope',
  outOfScopeJustification: 'Isolated VLAN',
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(assets: Asset[], extra: Routes = {}) {
  const stub = stubApi({ [LIST]: () => json(200, { assets }), ...extra });
  renderSsp('assets');
  return stub;
}

const panel = () => screen.getByRole('tabpanel', { name: 'Assets' });

async function loaded() {
  await screen.findByRole('form', { name: 'Add an asset' });
  await screen.findByText(/^\d+ assets?$/);
}

describe('Assets tab', () => {
  it('grouped inventory', async () => {
    open([LAPTOPS, SIEM, GUEST]);
    await loaded();
    const view = within(panel());
    expect(view.getByText('3 assets')).toBeInTheDocument();
    expect(view.getByRole('heading', { name: /Asset inventory/ })).toBeInTheDocument();

    const captions = ASSET_CATEGORIES.map((c) => `${ASSET_CATEGORY_LABELS[c]} · `);
    const found = Array.from(panel().querySelectorAll('caption, p'))
      .map((el) => el.textContent)
      .filter((t) => captions.some((c) => t.startsWith(c)));
    expect(found).toEqual([
      'CUI Assets · 1',
      'Security Protection Assets · 1',
      'Contractor Risk Managed Assets · 0',
      'Specialized Assets · 0',
      'Out-of-Scope Assets · 1',
    ]);
    expect(view.getAllByText('None recorded.')).toHaveLength(2);

    const cui = view.getByRole('table', { name: 'CUI Assets · 1' });
    expect(
      within(cui)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Type', 'Owner', 'Location', 'Treatment', 'Actions']);
    expect(within(cui).getByText('Laptop fleet')).toBeInTheDocument();
    expect(within(cui).getByText('Encrypted disks')).toBeInTheDocument();

    const oos = view.getByRole('table', { name: 'Out-of-Scope Assets · 1' });
    expect(
      within(oos)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Name',
      'Type',
      'Owner',
      'Location',
      'Treatment',
      'Out-of-scope justification',
      'Actions',
    ]);
    expect(within(oos).getByText('Isolated VLAN')).toBeInTheDocument();
  });

  it('an empty inventory says so five times and reads "0 assets"', async () => {
    open([]);
    await loaded();
    expect(within(panel()).getByText('0 assets')).toBeInTheDocument();
    expect(within(panel()).getAllByText('None recorded.')).toHaveLength(5);
  });

  it('a failed load shows Retry for this section only', async () => {
    let fail = true;
    stubApi({
      [LIST]: () => (fail ? apiError(500, 'internal') : json(200, { assets: [LAPTOPS] })),
    });
    renderSsp('assets');
    const user = userEvent.setup();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fail = false;
    await user.click(retry);
    expect(await screen.findByText('Laptop fleet')).toBeInTheDocument();
  });

  it('out-of-scope justification', async () => {
    const stub = open([LAPTOPS, GUEST]);
    await loaded();
    const user = userEvent.setup();
    const form = within(screen.getByRole('form', { name: 'Add an asset' }));

    // The justification shows only while the category is out of scope.
    expect(form.queryByLabelText('Out-of-scope justification')).toBeNull();
    await user.type(form.getByLabelText('Name'), 'Lab router');
    await user.selectOptions(form.getByLabelText('Category'), 'out_of_scope');
    expect(form.getByLabelText('Out-of-scope justification')).toBeInTheDocument();
    await user.click(form.getByRole('button', { name: 'Add asset' }));
    expect(await form.findByText('An out-of-scope asset needs a justification.')).toBeVisible();
    // Spaces alone are still blank.
    await user.type(form.getByLabelText('Out-of-scope justification'), '   ');
    await user.click(form.getByRole('button', { name: 'Add asset' }));
    expect(await form.findByText('An out-of-scope asset needs a justification.')).toBeVisible();
    expect(stub.sent(CREATE)).toHaveLength(0);

    // Switching an existing asset to out of scope.
    const row = within(panel()).getByRole('row', { name: /Laptop fleet/ });
    await user.click(within(row).getByRole('button', { name: 'Edit Laptop fleet' }));
    const edit = within(screen.getByRole('form', { name: 'Edit Laptop fleet' }));
    await user.selectOptions(edit.getByLabelText('Category'), 'out_of_scope');
    await user.click(edit.getByRole('button', { name: 'Save changes' }));
    expect(await edit.findByText('An out-of-scope asset needs a justification.')).toBeVisible();
    expect(stub.sent('PATCH /api/ssp/assets/a-1')).toHaveLength(0);

    // Blanking the justification of an out-of-scope asset is refused the same way.
    await user.click(edit.getByRole('button', { name: 'Cancel' }));
    const guest = within(panel()).getByRole('row', { name: /Guest Wi-Fi/ });
    await user.click(within(guest).getByRole('button', { name: 'Edit Guest Wi-Fi' }));
    const blank = within(screen.getByRole('form', { name: 'Edit Guest Wi-Fi' }));
    await user.clear(blank.getByLabelText('Out-of-scope justification'));
    await user.click(blank.getByRole('button', { name: 'Save changes' }));
    expect(await blank.findByText('An out-of-scope asset needs a justification.')).toBeVisible();
    expect(stub.sent('PATCH /api/ssp/assets/a-3')).toHaveLength(0);
  });

  it('server field error', async () => {
    const stub = open([], {
      [CREATE]: () =>
        apiError(400, 'validation_failed', 'Check the highlighted fields.', [
          { path: ['outOfScopeJustification'], message: 'Say why it is out of scope' },
        ]),
    });
    await loaded();
    const user = userEvent.setup();
    const form = within(screen.getByRole('form', { name: 'Add an asset' }));
    await user.type(form.getByLabelText('Name'), 'Printer');
    await user.selectOptions(form.getByLabelText('Category'), 'out_of_scope');
    await user.type(form.getByLabelText('Out-of-scope justification'), 'Air-gapped');
    await user.click(form.getByRole('button', { name: 'Add asset' }));
    await stub.waitForCall(CREATE);
    const field = await form.findByLabelText('Out-of-scope justification');
    await waitFor(() => {
      expect(field).toHaveAccessibleDescription(/Say why it is out of scope/);
    });
    expect(field).toBeInvalid();
    // A field error is not repeated in an Alert, and the draft is kept.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(form.getByLabelText('Name')).toHaveValue('Printer');
  });

  it('a 400 without a field shows its message in an Alert', async () => {
    const stub = open([], {
      [CREATE]: () => apiError(400, 'validation_failed', 'That did not validate.'),
    });
    await loaded();
    const user = userEvent.setup();
    const form = within(screen.getByRole('form', { name: 'Add an asset' }));
    await user.type(form.getByLabelText('Name'), 'Printer');
    await user.click(form.getByRole('button', { name: 'Add asset' }));
    await stub.waitForCall(CREATE);
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not validate.');
  });

  it('asset lifecycle', async () => {
    let assets = [LAPTOPS];
    const stub = open(assets, {
      [LIST]: () => json(200, { assets }),
      [CREATE]: ({ body }) => {
        const b = body as Partial<Asset> & { name: string; category: Asset['category'] };
        const made = asset({ id: 'a-9', ...b });
        assets = [...assets, made];
        return json(201, { asset: made });
      },
      'PATCH /api/ssp/assets/a-1': ({ body }) => {
        assets = assets.map((a) => (a.id === 'a-1' ? { ...a, ...(body as object) } : a));
        return json(200, { asset: assets[0] });
      },
      'DELETE /api/ssp/assets/a-1': () => {
        assets = assets.filter((a) => a.id !== 'a-1');
        return json(204);
      },
    });
    await loaded();
    const user = userEvent.setup();

    // Create: the body, then a reload of the list.
    const form = within(screen.getByRole('form', { name: 'Add an asset' }));
    expect(form.getByLabelText('Category')).toHaveValue('cui');
    await user.type(form.getByLabelText('Name'), '  Build server  ');
    await user.selectOptions(form.getByLabelText('Category'), 'spa');
    await user.type(form.getByLabelText('Owner'), 'DevOps');
    await user.click(form.getByRole('button', { name: 'Add asset' }));
    const [created] = await stub.waitForCall(CREATE);
    expect(created?.body).toEqual({
      name: 'Build server',
      category: 'spa',
      assetType: null,
      owner: 'DevOps',
      location: null,
      treatment: null,
      outOfScopeJustification: null,
    });
    expect(created?.headers.get('x-csrf-token')).toBe('csrf-1');
    await stub.waitForCall(LIST, 2);
    expect(await within(panel()).findByText('Build server')).toBeInTheDocument();
    expect(within(panel()).getByText('2 assets')).toBeInTheDocument();
    // The form is blank again.
    expect(screen.getByRole('form', { name: 'Add an asset' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('form', { name: 'Add an asset' })).getByLabelText('Name'),
    ).toHaveValue('');

    // Edit: prefilled, unchanged can't be saved, then only the changed key is sent.
    const row = within(panel()).getByRole('row', { name: /Laptop fleet/ });
    await user.click(within(row).getByRole('button', { name: 'Edit Laptop fleet' }));
    const edit = within(screen.getByRole('form', { name: 'Edit Laptop fleet' }));
    expect(edit.getByLabelText('Name')).toHaveValue('Laptop fleet');
    expect(edit.getByLabelText('Treatment')).toHaveValue('Encrypted disks');
    expect(edit.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.clear(edit.getByLabelText('Owner'));
    await user.type(edit.getByLabelText('Owner'), 'Infrastructure');
    await user.click(edit.getByRole('button', { name: 'Save changes' }));
    const [patched] = await stub.waitForCall('PATCH /api/ssp/assets/a-1');
    expect(patched?.body).toEqual({ owner: 'Infrastructure' });
    await stub.waitForCall(LIST, 3);
    expect(await within(panel()).findByText('Infrastructure')).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'Add an asset' })).toBeInTheDocument();

    // Cancel drops the draft.
    await user.click(
      within(within(panel()).getByRole('row', { name: /Laptop fleet/ })).getByRole('button', {
        name: 'Edit Laptop fleet',
      }),
    );
    const again = within(screen.getByRole('form', { name: 'Edit Laptop fleet' }));
    await user.type(again.getByLabelText('Name'), ' x');
    await user.click(again.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Edit Laptop fleet' })).toBeNull();
    await user.click(
      within(within(panel()).getByRole('row', { name: /Laptop fleet/ })).getByRole('button', {
        name: 'Edit Laptop fleet',
      }),
    );
    expect(
      within(screen.getByRole('form', { name: 'Edit Laptop fleet' })).getByLabelText('Name'),
    ).toHaveValue('Laptop fleet');
    await user.click(
      within(screen.getByRole('form', { name: 'Edit Laptop fleet' })).getByRole('button', {
        name: 'Cancel',
      }),
    );

    // Remove needs Confirm; Cancel sends nothing.
    const target = within(panel()).getByRole('row', { name: /Laptop fleet/ });
    await user.click(within(target).getByRole('button', { name: 'Remove' }));
    await user.click(within(target).getByRole('button', { name: 'Cancel' }));
    expect(stub.sent('DELETE /api/ssp/assets/a-1')).toHaveLength(0);
    await user.click(within(target).getByRole('button', { name: 'Remove' }));
    expect(within(target).getByText('Remove Laptop fleet?')).toBeInTheDocument();
    await user.click(within(target).getByRole('button', { name: 'Confirm remove' }));
    await stub.waitForCall('DELETE /api/ssp/assets/a-1');
    await stub.waitForCall(LIST, 4);
    await waitFor(() => {
      expect(within(panel()).queryByText('Laptop fleet')).toBeNull();
    });
    expect(within(panel()).getByText('1 asset')).toBeInTheDocument();
  });

  it('a 404 on remove shows the not-found text and reloads', async () => {
    const stub = open([LAPTOPS], {
      'DELETE /api/ssp/assets/a-1': () => apiError(404, 'not_found'),
    });
    await loaded();
    const user = userEvent.setup();
    const row = within(panel()).getByRole('row', { name: /Laptop fleet/ });
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    await user.click(within(row).getByRole('button', { name: 'Confirm remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'It was already removed. The list has been reloaded.',
    );
    await stub.waitForCall(LIST, 2);
  });

  it('a failed save keeps the draft and shows an Alert; a second click while pending sends once', async () => {
    const stub = open([], {});
    await loaded();
    const user = userEvent.setup();
    const held = stub.defer(CREATE);
    const form = within(screen.getByRole('form', { name: 'Add an asset' }));
    await user.type(form.getByLabelText('Name'), 'Printer');
    await user.click(form.getByRole('button', { name: 'Add asset' }));
    await held.requested;
    expect(form.getByRole('button', { name: 'Add asset' })).toBeDisabled();
    held.answer(apiError(500, 'internal'));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the asset");
    expect(form.getByLabelText('Name')).toHaveValue('Printer');
    expect(stub.sent(CREATE)).toHaveLength(1);
  });

  it('a blank name sends nothing', async () => {
    const stub = open([]);
    await loaded();
    const user = userEvent.setup();
    const form = within(screen.getByRole('form', { name: 'Add an asset' }));
    await user.click(form.getByRole('button', { name: 'Add asset' }));
    expect(await form.findByText('Enter an asset name')).toBeVisible();
    expect(stub.sent(CREATE)).toHaveLength(0);
  });
});
