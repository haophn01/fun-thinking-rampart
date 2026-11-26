import {
  DEFAULT_CATEGORIZATION,
  type DocumentControl,
  type SspProfile,
} from '@rampart/api/contract';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, renderSsp, stubApi, type Routes } from '../kit/testing';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const TODAY = '2026-11-25';
const TOMORROW = '2026-11-26';
const AT = '2026-11-20T10:00:00.000Z';

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

function control(overrides: Partial<DocumentControl> = {}): DocumentControl {
  return {
    reviewCadenceMonths: 12,
    nextReviewDate: null,
    nextReviewDue: null,
    daysToReview: null,
    reviewOverdue: false,
    revisions: [],
    approvals: [],
    ...overrides,
  };
}

const REVISION = {
  id: 'rev-1',
  kind: 'manual' as const,
  date: '2026-11-01',
  description: 'Rewrote the boundary',
  madeBy: 'Ada Admin',
  createdAt: AT,
};
const EXPORT_REVISION = {
  ...REVISION,
  id: 'rev-2',
  kind: 'export' as const,
  date: '2026-11-10',
  description: 'Exported the SSP',
  madeBy: 'Grace',
};
const APPROVAL = {
  id: 'ap-1',
  name: 'Ada Lovelace',
  title: 'CEO',
  approvedOn: '2026-10-01',
  createdAt: AT,
  updatedAt: AT,
};
const UNSIGNED = { ...APPROVAL, id: 'ap-2', name: 'Grace Hopper', title: 'CISO', approvedOn: null };

const GET = 'GET /api/ssp/document-control';

function api(
  state: { current: DocumentControl },
  routes: Routes = {},
  role: 'admin' | 'contributor' = 'admin',
) {
  return stubApi(
    {
      'GET /api/ssp/profile': () => json(200, { profile: PROFILE }),
      [GET]: () => json(200, state.current),
      ...routes,
    },
    { role },
  );
}

async function open() {
  renderSsp('document-control');
  await screen.findByRole('region', { name: /Review/ });
}
const section = (name: RegExp) => screen.getByRole('region', { name });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('review status', () => {
  it('says so when there is no review date', async () => {
    api({ current: control() });
    await open();
    expect(
      await screen.findByText('No review date yet. Set a next review date or record an approval.'),
    ).toBeInTheDocument();
  });

  it('counts the days left, in the singular and the plural', async () => {
    const state = { current: control({ nextReviewDue: '2026-12-05', daysToReview: 10 }) };
    api(state);
    await open();
    expect(await screen.findByText('Next review due 2026-12-05 · 10 days left')).toBeVisible();
  });

  it('uses "1 day left" for one day', async () => {
    api({ current: control({ nextReviewDue: TOMORROW, daysToReview: 1 }) });
    await open();
    expect(await screen.findByText(`Next review due ${TOMORROW} · 1 day left`)).toBeVisible();
  });

  it('says due today at zero days, without an error', async () => {
    api({ current: control({ nextReviewDue: TODAY, daysToReview: 0 }) });
    await open();
    expect(await screen.findByText(`Next review due today (${TODAY})`)).toBeVisible();
    expect(screen.queryByText('Review overdue')).not.toBeInTheDocument();
  });

  it('shows an error Alert when overdue', async () => {
    api({
      current: control({ nextReviewDue: '2026-11-20', daysToReview: -5, reviewOverdue: true }),
    });
    await open();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Review overdue')).toBeVisible();
    expect(within(alert).getByText('Due 2026-11-20 · 5 days overdue')).toBeVisible();
  });

  it('uses "1 day overdue" for one day', async () => {
    api({
      current: control({ nextReviewDue: '2026-11-24', daysToReview: -1, reviewOverdue: true }),
    });
    await open();
    expect(await screen.findByText('Due 2026-11-24 · 1 day overdue')).toBeVisible();
  });

  it('a failed load shows a retry for that section only', async () => {
    let failing = true;
    const state = { current: control() };
    api(state, {
      [GET]: () => (failing ? apiError(500, 'internal') : json(200, state.current)),
    });
    const user = userEvent.setup();
    renderSsp('document-control');
    const retries = await screen.findAllByRole('button', { name: 'Retry' });
    expect(retries.length).toBeGreaterThan(0);
    failing = false;
    await user.click(retries[0] as HTMLElement);
    expect(
      await screen.findByText('No review date yet. Set a next review date or record an approval.'),
    ).toBeVisible();
  });
});

describe('review schedule', () => {
  it('PATCHes only changed review keys and reloads the status', async () => {
    const state = { current: control({ nextReviewDue: '2026-12-05', daysToReview: 10 }) };
    const stub = api(state);
    const user = userEvent.setup();
    await open();
    await screen.findByText('Next review due 2026-12-05 · 10 days left');
    const form = screen.getByRole('form', { name: 'Review schedule' });
    const cadence = within(form).getByLabelText('Review every (months)');
    await user.clear(cadence);
    await user.type(cadence, '6');

    const patch = stub.defer('PATCH /api/ssp/profile');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const call = await patch.requested;
    expect(call.body).toEqual({ reviewCadenceMonths: 6 });
    state.current = control({
      reviewCadenceMonths: 6,
      nextReviewDue: '2027-05-25',
      daysToReview: 181,
    });
    patch.answer(json(200, { profile: { ...PROFILE, reviewCadenceMonths: 6 } }));

    expect(await screen.findByText('Next review due 2027-05-25 · 181 days left')).toBeVisible();
    expect(stub.sent(GET)).toHaveLength(2);
    expect(stub.sent('PATCH /api/ssp/profile')).toHaveLength(1);
  });

  it('sends nothing for an invalid cadence', async () => {
    const stub = api({ current: control() });
    const user = userEvent.setup();
    await open();
    const form = await screen.findByRole('form', { name: 'Review schedule' });
    const cadence = within(form).getByLabelText('Review every (months)');
    await user.clear(cadence);
    await user.type(cadence, '99');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(form).findByText('Enter a whole number of months from 1 to 60'),
    ).toBeVisible();
    expect(stub.sent('PATCH /api/ssp/profile')).toHaveLength(0);
  });
});

describe('record of changes', () => {
  it('lists entries with their kind and offers no edit or remove', async () => {
    api({ current: control({ revisions: [REVISION, EXPORT_REVISION] }) });
    await open();
    const region = section(/Record of changes/);
    expect(await within(region).findByText('Rewrote the boundary')).toBeVisible();
    const rows = within(region).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Manual')).toBeVisible();
    expect(within(rows[2] as HTMLElement).getByText('Export')).toBeVisible();
    expect(within(region).getByText("Entries can't be changed or removed.")).toBeVisible();
    expect(within(region).queryByRole('button', { name: /edit|remove|delete/i })).toBeNull();
    // The only button is the one that adds an entry.
    expect(
      within(region)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Add entry']);
  });

  it('defaults the date to today, omits a blank Made by and reloads', async () => {
    const state = { current: control() };
    const stub = api(state);
    const user = userEvent.setup();
    await open();
    const form = await screen.findByRole('form', { name: 'Add a change' });
    expect(within(form).getByLabelText('Date')).toHaveValue(TODAY);
    await user.type(within(form).getByLabelText('Description'), '  Annual review  ');

    const post = stub.defer('POST /api/ssp/revisions');
    await user.click(within(form).getByRole('button', { name: 'Add entry' }));
    const call = await post.requested;
    expect(call.body).toEqual({ date: TODAY, description: 'Annual review' });
    expect(Object.keys(call.body as object)).not.toContain('madeBy');
    state.current = control({ revisions: [{ ...REVISION, description: 'Annual review' }] });
    post.answer(json(201, { revision: REVISION }));

    const region = section(/Record of changes/);
    expect(await within(region).findByRole('cell', { name: /Annual review/ })).toBeVisible();
    expect(stub.sent(GET)).toHaveLength(2);
    // The form is ready for the next entry.
    expect(within(form).getByLabelText('Description')).toHaveValue('');
    expect(within(form).getByLabelText('Date')).toHaveValue(TODAY);
  });

  it('sends a typed Made by, trimmed', async () => {
    const stub = api(
      { current: control() },
      {
        'POST /api/ssp/revisions': () => json(201, { revision: REVISION }),
      },
    );
    const user = userEvent.setup();
    await open();
    const form = await screen.findByRole('form', { name: 'Add a change' });
    await user.type(within(form).getByLabelText('Description'), 'Patched');
    await user.type(within(form).getByLabelText('Made by'), ' Grace ');
    await user.click(within(form).getByRole('button', { name: 'Add entry' }));
    const [call] = await stub.waitForCall('POST /api/ssp/revisions');
    expect(call?.body).toEqual({ date: TODAY, description: 'Patched', madeBy: 'Grace' });
  });

  it('sends nothing for a future date, a bad date or a blank description', async () => {
    const stub = api({ current: control() });
    const user = userEvent.setup();
    await open();
    const form = await screen.findByRole('form', { name: 'Add a change' });
    const date = within(form).getByLabelText('Date');
    await user.type(within(form).getByLabelText('Description'), 'Something');
    await user.clear(date);
    await user.type(date, TOMORROW);
    await user.click(within(form).getByRole('button', { name: 'Add entry' }));
    expect(await within(form).findByText("The date can't be in the future.")).toBeVisible();

    await user.clear(date);
    await user.type(date, '2026-02-30');
    await user.click(within(form).getByRole('button', { name: 'Add entry' }));
    expect(await within(form).findByText('Enter a real date as YYYY-MM-DD.')).toBeVisible();

    await user.clear(date);
    await user.type(date, TODAY);
    await user.clear(within(form).getByLabelText('Description'));
    await user.click(within(form).getByRole('button', { name: 'Add entry' }));
    expect(await within(form).findByText('Enter a description.')).toBeVisible();
    expect(stub.sent('POST /api/ssp/revisions')).toHaveLength(0);
  });

  it('shows the api message when the server refuses the entry', async () => {
    api(
      { current: control() },
      {
        'POST /api/ssp/revisions': () =>
          apiError(400, 'validation_failed', 'Date is in the future.'),
      },
    );
    const user = userEvent.setup();
    await open();
    const form = await screen.findByRole('form', { name: 'Add a change' });
    await user.type(within(form).getByLabelText('Description'), 'x');
    await user.click(within(form).getByRole('button', { name: 'Add entry' }));
    expect(await within(form).findByText('Date is in the future.')).toBeVisible();
  });
});

describe('approvals admin', () => {
  const route = (key: string, handler: () => Response): Routes => ({ [key]: handler });

  it('lists approvals, with "Not signed yet" for a blank date', async () => {
    api({ current: control({ approvals: [APPROVAL, UNSIGNED] }) });
    await open();
    const region = section(/Approvals/);
    expect(await within(region).findByText('Ada Lovelace')).toBeVisible();
    expect(within(region).getByText('2026-10-01')).toBeVisible();
    expect(within(region).getByText('Not signed yet')).toBeVisible();
    expect(
      within(region).getByText('Each approval prints as a signature line in the SSP.'),
    ).toBeVisible();
  });

  it('creates an approval, sending null for a blank Approved on', async () => {
    const state = { current: control() };
    const stub = api(state);
    const user = userEvent.setup();
    await open();
    const form = await screen.findByRole('form', { name: 'Add an approval' });
    await user.type(within(form).getByLabelText('Name'), ' Ada Lovelace ');
    await user.type(within(form).getByLabelText('Title'), 'CEO');
    const post = stub.defer('POST /api/ssp/approvals');
    await user.click(within(form).getByRole('button', { name: 'Add approval' }));
    expect((await post.requested).body).toEqual({
      name: 'Ada Lovelace',
      title: 'CEO',
      approvedOn: null,
    });
    state.current = control({ approvals: [UNSIGNED] });
    post.answer(json(201, { approval: UNSIGNED }));
    expect(await within(section(/Approvals/)).findByText('Grace Hopper')).toBeVisible();
    expect(stub.sent(GET)).toHaveLength(2);
    expect(within(form).getByLabelText('Name')).toHaveValue('');
  });

  it('sends a typed Approved on', async () => {
    const stub = api(
      { current: control() },
      route('POST /api/ssp/approvals', () => json(201, { approval: APPROVAL })),
    );
    const user = userEvent.setup();
    await open();
    const form = await screen.findByRole('form', { name: 'Add an approval' });
    await user.type(within(form).getByLabelText('Name'), 'Ada');
    await user.type(within(form).getByLabelText('Title'), 'CEO');
    await user.type(within(form).getByLabelText('Approved on'), TODAY);
    await user.click(within(form).getByRole('button', { name: 'Add approval' }));
    const [call] = await stub.waitForCall('POST /api/ssp/approvals');
    expect(call?.body).toEqual({ name: 'Ada', title: 'CEO', approvedOn: TODAY });
  });

  it('sends nothing for a future or bad Approved on, or a blank name or title', async () => {
    const stub = api({ current: control() });
    const user = userEvent.setup();
    await open();
    const form = await screen.findByRole('form', { name: 'Add an approval' });
    await user.click(within(form).getByRole('button', { name: 'Add approval' }));
    expect(await within(form).findByText('Enter a name.')).toBeVisible();
    expect(within(form).getByText('Enter a title.')).toBeVisible();

    await user.type(within(form).getByLabelText('Name'), 'Ada');
    await user.type(within(form).getByLabelText('Title'), 'CEO');
    const on = within(form).getByLabelText('Approved on');
    await user.type(on, TOMORROW);
    await user.click(within(form).getByRole('button', { name: 'Add approval' }));
    expect(await within(form).findByText("The date can't be in the future.")).toBeVisible();
    await user.clear(on);
    await user.type(on, '2026-13-01');
    await user.click(within(form).getByRole('button', { name: 'Add approval' }));
    expect(await within(form).findByText('Enter a real date as YYYY-MM-DD.')).toBeVisible();
    expect(stub.sent('POST /api/ssp/approvals')).toHaveLength(0);
  });

  it('edits in place, PATCHing only the changed keys; unchanged cannot be saved', async () => {
    const state = { current: control({ approvals: [APPROVAL] }) };
    const stub = api(state);
    const user = userEvent.setup();
    await open();
    const region = section(/Approvals/);
    await user.click(await within(region).findByRole('button', { name: 'Edit Ada Lovelace' }));
    const form = screen.getByRole('form', { name: 'Edit approval' });
    expect(within(form).getByLabelText('Name')).toHaveValue('Ada Lovelace');
    expect(within(form).getByLabelText('Approved on')).toHaveValue('2026-10-01');
    const save = within(form).getByRole('button', { name: 'Save approval' });
    expect(save).toBeDisabled();

    await user.clear(within(form).getByLabelText('Title'));
    await user.type(within(form).getByLabelText('Title'), 'President');
    const patch = stub.defer('PATCH /api/ssp/approvals/ap-1');
    await user.click(save);
    expect((await patch.requested).body).toEqual({ title: 'President' });
    state.current = control({ approvals: [{ ...APPROVAL, title: 'President' }] });
    patch.answer(json(200, { approval: { ...APPROVAL, title: 'President' } }));
    expect(await within(region).findByText('President')).toBeVisible();
    expect(stub.sent(GET)).toHaveLength(2);
    expect(screen.queryByRole('form', { name: 'Edit approval' })).toBeNull();
    expect(screen.getByRole('form', { name: 'Add an approval' })).toBeVisible();
  });

  it('clearing Approved on sends null; Cancel drops the draft', async () => {
    const stub = api(
      { current: control({ approvals: [APPROVAL] }) },
      route('PATCH /api/ssp/approvals/ap-1', () =>
        json(200, { approval: { ...APPROVAL, approvedOn: null } }),
      ),
    );
    const user = userEvent.setup();
    await open();
    const region = section(/Approvals/);
    await user.click(await within(region).findByRole('button', { name: 'Edit Ada Lovelace' }));
    let form = screen.getByRole('form', { name: 'Edit approval' });
    await user.clear(within(form).getByLabelText('Name'));
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Edit approval' })).toBeNull();

    await user.click(within(region).getByRole('button', { name: 'Edit Ada Lovelace' }));
    form = screen.getByRole('form', { name: 'Edit approval' });
    expect(within(form).getByLabelText('Name')).toHaveValue('Ada Lovelace');
    await user.clear(within(form).getByLabelText('Approved on'));
    await user.click(within(form).getByRole('button', { name: 'Save approval' }));
    const [call] = await stub.waitForCall('PATCH /api/ssp/approvals/ap-1');
    expect(call?.body).toEqual({ approvedOn: null });
  });

  it('removes after Confirm and reloads', async () => {
    const state = { current: control({ approvals: [APPROVAL, UNSIGNED] }) };
    const stub = api(state);
    const user = userEvent.setup();
    await open();
    const region = section(/Approvals/);
    const row = (await within(region).findByText('Ada Lovelace')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(stub.sent('DELETE /api/ssp/approvals/ap-1')).toHaveLength(0);
    const del = stub.defer('DELETE /api/ssp/approvals/ap-1');
    await user.click(within(row).getByRole('button', { name: 'Confirm remove' }));
    await del.requested;
    state.current = control({ approvals: [UNSIGNED] });
    del.answer(json(204));
    await waitFor(() => {
      expect(within(region).queryByText('Ada Lovelace')).toBeNull();
    });
    expect(stub.sent(GET)).toHaveLength(2);
  });

  it('shows its own error when a remove fails, and the not-found text reloads', async () => {
    const state = { current: control({ approvals: [APPROVAL] }) };
    const stub = api(state, {
      'DELETE /api/ssp/approvals/ap-1': () => apiError(404, 'not_found'),
    });
    const user = userEvent.setup();
    await open();
    const region = section(/Approvals/);
    await user.click(await within(region).findByRole('button', { name: 'Remove' }));
    state.current = control();
    await user.click(within(region).getByRole('button', { name: 'Confirm remove' }));
    expect(
      await within(region).findByText('It was already removed. The list has been reloaded.'),
    ).toBeVisible();
    await waitFor(() => {
      expect(stub.sent(GET)).toHaveLength(2);
    });
  });

  it('shows the not-found text when editing an approval that is gone', async () => {
    const state = { current: control({ approvals: [APPROVAL] }) };
    const stub = api(state, {
      'PATCH /api/ssp/approvals/ap-1': () => apiError(404, 'not_found'),
    });
    const user = userEvent.setup();
    await open();
    const region = section(/Approvals/);
    await user.click(await within(region).findByRole('button', { name: 'Edit Ada Lovelace' }));
    const form = screen.getByRole('form', { name: 'Edit approval' });
    await user.type(within(form).getByLabelText('Title'), '!');
    state.current = control();
    await user.click(within(form).getByRole('button', { name: 'Save approval' }));
    expect(
      await within(region).findByText('It was already removed. The list has been reloaded.'),
    ).toBeVisible();
    await waitFor(() => {
      expect(stub.sent(GET)).toHaveLength(2);
    });
  });
});

describe('approvals contributor', () => {
  it('sees the list and the admin-only note, with no form or buttons', async () => {
    api({ current: control({ approvals: [APPROVAL, UNSIGNED] }) }, {}, 'contributor');
    await open();
    const region = section(/Approvals/);
    expect(await within(region).findByText('Ada Lovelace')).toBeVisible();
    expect(within(region).getByText('Not signed yet')).toBeVisible();
    expect(within(region).getByText('Only an admin can change approvals.')).toBeVisible();
    expect(within(region).queryByRole('button')).toBeNull();
    expect(within(region).queryByRole('form')).toBeNull();
    expect(within(region).queryByRole('columnheader', { name: 'Actions' })).toBeNull();
  });
});
