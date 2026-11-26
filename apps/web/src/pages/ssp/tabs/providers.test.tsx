import type {
  ResponsibilityParty,
  ResponsibilityRow,
  ServiceProvider,
} from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, renderSsp, stubApi, type Routes } from '../kit/testing';

// The test timeout sits above the 5 s wait, so a wait that never succeeds names itself.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = loadCatalog();
const IDS = CATALOG.requirements.map((r) => r.id);
const AC = CATALOG.families.find((f) => f.code === 'AC');
const AT_ = '2026-11-24T10:00:00.000Z';
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const PROVIDERS = '/api/ssp/providers';
const MATRIX = '/api/ssp/responsibilities';

function provider(id: string, name: string, extra: Partial<ServiceProvider> = {}): ServiceProvider {
  return {
    id,
    name,
    providerType: 'cloud',
    fedrampStatus: null,
    services: null,
    agreementReference: null,
    createdAt: AT_,
    updatedAt: AT_,
    ...extra,
  };
}

interface Stored {
  party: ResponsibilityParty | null;
  providerId: string | null;
  note: string | null;
}

/**
 * The provider and matrix routes over in-memory data, answering like the api: providers by
 * name, 409 provider_in_use for a named provider, strict party/provider pairing on PUT.
 */
interface FakeData {
  providers?: ServiceProvider[];
  stored?: Record<string, Stored>;
  extra?: Routes;
}

function fakeApi({ providers = [], stored = {}, extra = {} }: FakeData = {}) {
  let list = [...providers];
  const rows = new Map(Object.entries(stored));
  const nameOf = (id: string | null) => list.find((p) => p.id === id)?.name ?? '';
  const row = (id: string): ResponsibilityRow => {
    const s = rows.get(id);
    return {
      requirementId: id,
      party: s?.party ?? null,
      provider: s?.providerId == null ? null : { id: s.providerId, name: nameOf(s.providerId) },
      note: s?.note ?? null,
      updatedAt: s === undefined ? null : AT_,
    };
  };
  const routes: Routes = {
    [`GET ${PROVIDERS}`]: () =>
      json(200, {
        providers: [...list].sort((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        ),
      }),
    [`GET ${MATRIX}`]: () => json(200, { rows: IDS.map(row) }),
    [`POST ${PROVIDERS}`]: (call) => {
      const created = provider(NEW_ID, '', call.body as Partial<ServiceProvider>);
      list.push(created);
      return json(201, { provider: created });
    },
  };
  for (const id of [P1, P2, NEW_ID]) {
    routes[`PATCH ${PROVIDERS}/${id}`] = (call) => {
      const found = list.find((p) => p.id === id);
      if (found === undefined) return apiError(404, 'not_found');
      Object.assign(found, call.body);
      return json(200, { provider: found });
    };
    routes[`DELETE ${PROVIDERS}/${id}`] = () => {
      const named = IDS.filter((r) => rows.get(r)?.providerId === id);
      if (named.length > 0) {
        return apiError(409, 'provider_in_use', 'The provider is still named', {
          requirementIds: named,
        });
      }
      list = list.filter((p) => p.id !== id);
      return json(204);
    };
  }
  for (const id of IDS) {
    routes[`PUT ${MATRIX}/${id}`] = (call) => {
      const body = call.body as Stored;
      const needs = body.party === 'esp' || body.party === 'shared';
      if (needs !== (body.providerId !== null)) {
        return apiError(400, 'validation_failed', 'Bad pairing', [
          { path: ['providerId'], message: 'Bad pairing' },
        ]);
      }
      rows.set(id, body);
      return json(200, { row: row(id) });
    };
  }
  return stubApi({ ...routes, ...extra });
}

async function openTab() {
  renderSsp('providers');
  await screen.findByRole('combobox', { name: 'Party for AC.L2-3.1.1' });
}

function providerTable() {
  return screen.getByRole('table', { name: /Service providers/ });
}

function providerRow(name: string) {
  const found = within(providerTable())
    .getAllByRole('row')
    .find((r) => within(r).queryByText(name, { exact: true }) !== null);
  if (found === undefined) throw new Error(`no provider row ${name}`);
  return found;
}

const familyHeadings = () =>
  within(screen.getByRole('region', { name: /Responsibility matrix/ })).getAllByRole('heading', {
    level: 3,
  });
const party = (id: string) => screen.getByRole('combobox', { name: `Party for ${id}` });
const providerSelect = (id: string) => screen.getByRole('combobox', { name: `Provider for ${id}` });
const note = (id: string) => screen.getByRole('textbox', { name: `Note for ${id}` });
const save = (id: string) => screen.getByRole('button', { name: `Save ${id}` });

describe('ProvidersTab', () => {
  it('provider lifecycle', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ providers: [provider(P1, 'Zeta MSP', { providerType: 'msp' })] });
    await openTab();

    // The table reads the server's row with labels.
    const zeta = providerRow('Zeta MSP');
    expect(within(zeta).getByText('Managed service provider')).toBeInTheDocument();

    // Name is required: nothing is sent.
    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(screen.getByText('Enter a provider name')).toBeInTheDocument();
    expect(api.sent(`POST ${PROVIDERS}`)).toHaveLength(0);

    // Create sends every key, blank as null, and reloads both lists.
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '  Acme Cloud ');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'cloud');
    await user.type(
      screen.getByRole('textbox', { name: 'FedRAMP or equivalent' }),
      'FedRAMP Moderate',
    );
    expect(screen.getByText('e.g. FedRAMP Moderate, or equivalent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    const [posted] = await api.waitForCall(`POST ${PROVIDERS}`);
    expect(posted?.body).toEqual({
      name: 'Acme Cloud',
      providerType: 'cloud',
      fedrampStatus: 'FedRAMP Moderate',
      services: null,
      agreementReference: null,
    });
    await api.waitForCall(`GET ${PROVIDERS}`, 2);
    await api.waitForCall(`GET ${MATRIX}`, 2);
    // The reloaded list is the server's, in name order; the form is empty again.
    await waitFor(() => {
      expect(
        within(providerTable())
          .getAllByRole('row')
          .slice(1)
          .map((r) => within(r).getAllByRole('cell')[0]?.textContent),
      ).toEqual(['NameAcme Cloud', 'NameZeta MSP']);
    });
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');

    // Edit opens prefilled; unchanged can't be saved; only changed keys go.
    await user.click(screen.getByRole('button', { name: 'Edit Zeta MSP' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Zeta MSP');
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('msp');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Services' }), 'Email, backups');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const [patched] = await api.waitForCall(`PATCH ${PROVIDERS}/${P1}`);
    expect(patched?.body).toEqual({ services: 'Email, backups' });
    await api.waitForCall(`GET ${PROVIDERS}`, 3);
    await api.waitForCall(`GET ${MATRIX}`, 3);
    expect(await within(providerRow('Zeta MSP')).findByText('Email, backups')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add provider' })).toBeInTheDocument();

    // Cancel drops an edit draft.
    await user.click(screen.getByRole('button', { name: 'Edit Zeta MSP' }));
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');

    // Remove needs Confirm, sends DELETE and reloads both lists.
    await user.click(within(providerRow('Zeta MSP')).getByRole('button', { name: 'Remove' }));
    expect(api.sent(`DELETE ${PROVIDERS}/${P1}`)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await api.waitForCall(`DELETE ${PROVIDERS}/${P1}`);
    await api.waitForCall(`GET ${PROVIDERS}`, 4);
    await api.waitForCall(`GET ${MATRIX}`, 4);
    await waitFor(() => {
      expect(within(providerTable()).queryByText('Zeta MSP')).not.toBeInTheDocument();
    });
    expect(providerRow('Acme Cloud')).toBeInTheDocument();
  });

  it('provider in use', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      providers: [provider(P1, 'Acme Cloud')],
      stored: {
        'AC.L2-3.1.2': { party: 'esp', providerId: P1, note: null },
        'AC.L2-3.1.1': { party: 'shared', providerId: P1, note: null },
      },
    });
    await openTab();
    await user.click(within(providerRow('Acme Cloud')).getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await api.waitForCall(`DELETE ${PROVIDERS}/${P1}`);
    expect(
      await screen.findByText(
        'Acme Cloud is named on 2 requirements: AC.L2-3.1.1, AC.L2-3.1.2. Point those rows elsewhere, then remove it.',
      ),
    ).toBeInTheDocument();
    expect(providerRow('Acme Cloud')).toBeInTheDocument();
    expect(api.sent(`GET ${PROVIDERS}`)).toHaveLength(1);
  });

  it('provider in use names one requirement in the singular', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      providers: [provider(P1, 'Acme Cloud')],
      stored: { 'SC.L2-3.13.1': { party: 'esp', providerId: P1, note: null } },
    });
    await openTab();
    await user.click(within(providerRow('Acme Cloud')).getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await api.waitForCall(`DELETE ${PROVIDERS}/${P1}`);
    expect(
      await screen.findByText(
        'Acme Cloud is named on 1 requirement: SC.L2-3.13.1. Point those rows elsewhere, then remove it.',
      ),
    ).toBeInTheDocument();
  });

  it('matrix rows and filter', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      providers: [provider(P1, 'Acme Cloud')],
      stored: {
        'AC.L2-3.1.1': { party: 'organization', providerId: null, note: null },
        'SC.L2-3.13.1': { party: 'esp', providerId: P1, note: 'Firewall' },
      },
    });
    await openTab();
    expect(screen.getByText('2 of 110 assigned')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox', { name: /^Party for / })).toHaveLength(110);
    const headings = familyHeadings();
    expect(headings.map((h) => h.textContent)).toEqual(
      CATALOG.families.map((f) => `${f.code} — ${f.name}`),
    );
    // Stored values show in their rows.
    expect(party('SC.L2-3.13.1')).toHaveValue('esp');
    expect(providerSelect('SC.L2-3.13.1')).toHaveValue(P1);
    expect(note('SC.L2-3.13.1')).toHaveValue('Firewall');

    // The family filter shows one family; the count stays the whole matrix's.
    const family = screen.getByRole('combobox', { name: 'Family' });
    expect(within(family).getAllByRole('option')[0]).toHaveTextContent('All families');
    await user.selectOptions(family, 'AC');
    expect(familyHeadings().map((h) => h.textContent)).toEqual(['AC — Access Control']);
    expect(screen.getAllByRole('combobox', { name: /^Party for / })).toHaveLength(
      AC?.requirementIds.length ?? -1,
    );
    expect(screen.getByText('2 of 110 assigned')).toBeInTheDocument();

    // The count follows saved rows, not drafts.
    await user.selectOptions(party('AC.L2-3.1.2'), 'organization');
    expect(screen.getByText('2 of 110 assigned')).toBeInTheDocument();
    await user.click(save('AC.L2-3.1.2'));
    await api.waitForCall(`PUT ${MATRIX}/AC.L2-3.1.2`);
    expect(await screen.findByText('3 of 110 assigned')).toBeInTheDocument();

    // Not set on a stored row sends all null and the count drops.
    await user.selectOptions(party('AC.L2-3.1.1'), '');
    await user.click(save('AC.L2-3.1.1'));
    const [cleared] = await api.waitForCall(`PUT ${MATRIX}/AC.L2-3.1.1`);
    expect(cleared?.body).toEqual({ party: null, providerId: null, note: null });
    expect(await screen.findByText('2 of 110 assigned')).toBeInTheDocument();

    // Back to all families.
    await user.selectOptions(family, '');
    expect(familyHeadings()).toHaveLength(CATALOG.families.length);
  });

  it('matrix row edges', async () => {
    const user = userEvent.setup();
    const id = 'AC.L2-3.1.3';
    const api = fakeApi({ providers: [provider(P1, 'Acme Cloud'), provider(P2, 'Beta MSSP')] });
    await openTab();

    // An unchanged row can't be saved; the provider is off until ESP or Shared.
    expect(save(id)).toBeDisabled();
    expect(providerSelect(id)).toBeDisabled();

    // ESP with no provider: the message, and nothing sent.
    await user.selectOptions(party(id), 'esp');
    expect(providerSelect(id)).toBeEnabled();
    expect(save(id)).toBeEnabled();
    await user.click(save(id));
    expect(screen.getByText('Choose the provider for this requirement.')).toBeInTheDocument();
    expect(providerSelect(id)).toHaveAccessibleDescription(
      'Choose the provider for this requirement.',
    );
    expect(api.sent(`PUT ${MATRIX}/${id}`)).toHaveLength(0);

    // With a provider and a note, all three keys go; the row reads the answer.
    await user.selectOptions(providerSelect(id), P2);
    expect(screen.queryByText('Choose the provider for this requirement.')).not.toBeInTheDocument();
    await user.type(note(id), '  Managed SOC  ');
    const put = api.defer(`PUT ${MATRIX}/${id}`);
    await user.click(save(id));
    const sent = await put.requested;
    expect(sent.body).toEqual({ party: 'esp', providerId: P2, note: 'Managed SOC' });
    expect(save(id)).toBeDisabled();
    put.answer(
      json(200, {
        row: {
          requirementId: id,
          party: 'esp',
          provider: { id: P2, name: 'Beta MSSP' },
          note: 'Managed SOC',
          updatedAt: AT_,
        },
      }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(save(id)).toBeDisabled();
    expect(note(id)).toHaveValue('Managed SOC');

    // Organization clears the provider and turns it off.
    await user.selectOptions(party(id), 'organization');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(providerSelect(id)).toBeDisabled();
    expect(providerSelect(id)).toHaveValue('');
    // Going back to the stored values isn't a change.
    await user.selectOptions(party(id), 'esp');
    await user.selectOptions(providerSelect(id), P2);
    expect(save(id)).toBeDisabled();
    await user.selectOptions(party(id), 'organization');
    await user.clear(note(id));
    await user.click(save(id));
    const puts = await api.waitForCall(`PUT ${MATRIX}/${id}`, 2);
    expect(puts[1]?.body).toEqual({ party: 'organization', providerId: null, note: null });

    // A server 400 at providerId shows on the Provider field.
    const other = 'AC.L2-3.1.4';
    const refused = api.defer(`PUT ${MATRIX}/${other}`);
    await user.selectOptions(party(other), 'shared');
    await user.selectOptions(providerSelect(other), P1);
    await user.click(save(other));
    await refused.requested;
    refused.answer(
      apiError(400, 'validation_failed', 'Provider not found', [
        { path: ['providerId'], message: 'Provider not found' },
      ]),
    );
    expect(await screen.findByText('Provider not found')).toBeInTheDocument();
    expect(providerSelect(other)).toHaveAccessibleDescription('Provider not found');
    expect(save(other)).toBeEnabled();

    // Any other failure shows in the row and keeps the draft.
    const failed = api.defer(`PUT ${MATRIX}/${other}`);
    await user.click(save(other));
    await failed.requested;
    failed.answer(apiError(500, 'internal'));
    expect(await screen.findByText("Can't save this row. Try again.")).toBeInTheDocument();
    expect(party(other)).toHaveValue('shared');
  });

  it('matrix with no providers shows the hint', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    await openTab();
    expect(await screen.findByText('No service providers yet.')).toBeInTheDocument();
    expect(screen.getByText('Add a service provider first.')).toBeInTheDocument();
    const id = 'AC.L2-3.1.5';
    await user.selectOptions(party(id), 'shared');
    expect(providerSelect(id)).toBeDisabled();
    await user.click(save(id));
    expect(screen.getByText('Choose the provider for this requirement.')).toBeInTheDocument();
    expect(api.sent(`PUT ${MATRIX}/${id}`)).toHaveLength(0);
  });

  it('matrix follows providers', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      providers: [provider(P1, 'Acme Cloud')],
      stored: { 'AU.L2-3.3.1': { party: 'esp', providerId: P1, note: null } },
    });
    await openTab();
    expect(
      within(providerSelect('AU.L2-3.3.1')).getByRole('option', { selected: true }),
    ).toHaveTextContent('Acme Cloud');
    // A draft elsewhere survives the reload.
    await user.type(note('AC.L2-3.1.6'), 'Draft');

    await user.click(screen.getByRole('button', { name: 'Edit Acme Cloud' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Acme Prime');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const [patched] = await api.waitForCall(`PATCH ${PROVIDERS}/${P1}`);
    expect(patched?.body).toEqual({ name: 'Acme Prime' });
    await api.waitForCall(`GET ${MATRIX}`, 2);
    await waitFor(() => {
      expect(
        within(providerSelect('AU.L2-3.3.1')).getByRole('option', { selected: true }),
      ).toHaveTextContent('Acme Prime');
    });
    expect(within(providerSelect('AC.L2-3.1.1')).queryByText('Acme Cloud')).not.toBeInTheDocument();
    expect(note('AC.L2-3.1.6')).toHaveValue('Draft');
  });

  it('each section loads and fails on its own', async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = fakeApi({
      extra: {
        [`GET ${MATRIX}`]: () =>
          fail
            ? apiError(500, 'internal')
            : json(200, {
                rows: IDS.map((requirementId) => ({
                  requirementId,
                  party: null,
                  provider: null,
                  note: null,
                  updatedAt: null,
                })),
              }),
      },
    });
    const held = api.defer(`GET ${PROVIDERS}`);
    renderSsp('providers');
    expect(await screen.findByText('Loading the service providers…')).toBeInTheDocument();
    await held.requested;
    held.answer(json(200, { providers: [provider(P1, 'Acme Cloud')] }));
    expect(await screen.findByText("Can't load the responsibility matrix")).toBeInTheDocument();
    expect(providerRow('Acme Cloud')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('0 of 110 assigned')).toBeInTheDocument();
    expect(api.sent(`GET ${PROVIDERS}`)).toHaveLength(1);
  });
});
