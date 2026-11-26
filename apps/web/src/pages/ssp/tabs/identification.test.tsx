import type { SspProfile, SystemRole } from '@rampart/api/contract';
import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, renderSsp, stubApi, ME, type Routes } from '../kit/testing';

// A page test waits for real requests; keep the timeout above the 5 s waits.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const AT = '2026-11-24T10:00:00.000Z';
const REMOVED = 'It was already removed. The list has been reloaded.';

const PROFILE: SspProfile = {
  categorization: 'Moderate',
  securityOfficer: 'Sam Officer',
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
  updatedAt: AT,
  updatedBy: ME,
};

const V1_PROFILE = {
  systemName: null,
  systemIdentifier: null,
  organizationName: null,
  cageCode: null,
  description: null,
  authorizationBoundary: null,
  environment: null,
  interconnections: null,
  informationTypes: null,
  systemOwner: null,
  systemOwnerEmail: null,
  securityContact: null,
  securityContactEmail: null,
  updatedAt: null,
  updatedBy: null,
};

function makeRole(id: string, over: Partial<SystemRole> = {}): SystemRole {
  return {
    id,
    title: `Role ${id}`,
    person: null,
    responsibilities: null,
    userCount: 1,
    privileged: false,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

/** The api over an in-memory roles list, with totals the way the server sums them. */
function rolesApi(
  initial: SystemRole[],
  extra: Routes = {},
  sessionRole: 'admin' | 'contributor' = 'admin',
) {
  let roles = initial;
  let next = 100;
  const totals = () => ({
    users: roles.reduce((n, r) => n + r.userCount, 0),
    privilegedUsers: roles.filter((r) => r.privileged).reduce((n, r) => n + r.userCount, 0),
  });
  return stubApi(
    {
      'GET /api/system-profile': () => json(200, { profile: V1_PROFILE }),
      'GET /api/ssp/profile': () => json(200, { profile: PROFILE }),
      'PATCH /api/ssp/profile': (call) =>
        json(200, { profile: { ...PROFILE, ...(call.body as object) } }),
      'GET /api/ssp/roles': () => json(200, { roles, totals: totals() }),
      'POST /api/ssp/roles': (call) => {
        next += 1;
        const created = makeRole(String(next), call.body as Partial<SystemRole>);
        roles = [...roles, created];
        return json(201, { role: created });
      },
      'PATCH /api/ssp/roles/r1': (call) => {
        roles = roles.map((r) => (r.id === 'r1' ? { ...r, ...(call.body as object) } : r));
        return json(200, { role: roles[0] });
      },
      'DELETE /api/ssp/roles/r1': () => {
        roles = roles.filter((r) => r.id !== 'r1');
        return json(204);
      },
      ...extra,
    },
    { role: sessionRole },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rolesSection() {
  return screen.findByRole('region', { name: /Roles/ });
}

describe('identification tab', () => {
  it('identification fields', async () => {
    const user = userEvent.setup();
    const api = rolesApi([]);
    renderSsp();
    const form = await screen.findByRole('form', { name: 'Identification' });
    await api.waitForCall('GET /api/ssp/profile');

    // Only the identification group, in contract order, with the saved values.
    const labels = within(form)
      .getAllByRole('textbox')
      .map((el) => form.querySelector(`label[for="${el.id}"]`)?.textContent);
    expect(labels).toEqual([
      'Security categorization',
      'System security officer',
      'System security officer email',
      'Organization address',
      'Organization phone',
    ]);
    expect(within(form).getByLabelText('Security categorization')).toHaveValue('Moderate');
    expect(within(form).getByLabelText('System security officer')).toHaveValue('Sam Officer');

    // Three numbered sections, in order.
    const panel = screen.getByRole('tabpanel', { name: 'Identification & roles' });
    const regions = within(panel).getAllByRole('region');
    expect(regions).toHaveLength(3);
    expect(regions[0]).toHaveAccessibleName(/System profile/);
    expect(regions[1]).toHaveAccessibleName(/Identification/);
    expect(regions[2]).toHaveAccessibleName(/Roles/);

    await user.type(within(form).getByLabelText('Organization phone'), '555-0100');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Saved')).toBeInTheDocument();
    const patches = api.sent('PATCH /api/ssp/profile');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ organizationPhone: '555-0100' });
    // The V1 profile form is untouched.
    expect(api.sent('PATCH /api/system-profile')).toHaveLength(0);
  });

  it('fails the identification load on its own, with Retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = rolesApi([], {
      'GET /api/ssp/profile': () =>
        fail ? apiError(500, 'internal') : json(200, { profile: PROFILE }),
    });
    renderSsp();
    const title = await screen.findByText("Can't load the identification details");
    // The roles section and the V1 form are unaffected.
    expect(await rolesSection()).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'System profile' })).toBeInTheDocument();
    fail = false;
    const alert = title.closest('[role="alert"]') as HTMLElement;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('form', { name: 'Identification' })).toBeInTheDocument();
    expect(api.sent('GET /api/ssp/profile')).toHaveLength(2);
  });

  it('add role', async () => {
    const user = userEvent.setup();
    const api = rolesApi([
      makeRole('r1', { title: 'Administrator', userCount: 2, privileged: true }),
      makeRole('r2', { title: 'Analyst', userCount: 5 }),
    ]);
    renderSsp();
    const section = await rolesSection();
    const table = await within(section).findByRole('table');
    // Existing rows, the server's totals and the hint.
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Role', 'Person', 'Responsibilities', 'Users', 'Privileged', 'Actions']);
    expect(within(table).getByText('Administrator')).toBeInTheDocument();
    expect(within(section).getByText('7 users · 2 privileged')).toBeInTheDocument();
    expect(
      within(section).getByText("The SSP's privileged and admin count comes from this table."),
    ).toBeInTheDocument();

    const form = within(section).getByRole('form', { name: 'Add role' });
    await user.type(within(form).getByLabelText('Title'), 'Auditor');
    await user.type(within(form).getByLabelText('Person'), 'Pat');
    await user.type(within(form).getByLabelText('Responsibilities'), 'Reviews logs');
    await user.type(within(form).getByLabelText('Number of users'), '3');
    await user.click(within(form).getByRole('checkbox', { name: 'Privileged' }));
    await user.click(within(form).getByRole('button', { name: 'Add role' }));

    // The body is sent, then the list is reloaded and the totals are the server's.
    const posts = await api.waitForCall('POST /api/ssp/roles');
    expect(posts[0]?.body).toEqual({
      title: 'Auditor',
      person: 'Pat',
      responsibilities: 'Reviews logs',
      userCount: 3,
      privileged: true,
    });
    await api.waitForCall('GET /api/ssp/roles', 2);
    expect(await within(section).findByText('Auditor')).toBeInTheDocument();
    expect(within(section).getByText('10 users · 5 privileged')).toBeInTheDocument();
    // The form is empty again.
    const fresh = within(section).getByRole('form', { name: 'Add role' });
    expect(within(fresh).getByLabelText('Title')).toHaveValue('');
    expect(within(fresh).getByRole('checkbox', { name: 'Privileged' })).not.toBeChecked();
  });

  it('role validation', async () => {
    const user = userEvent.setup();
    const api = rolesApi([]);
    renderSsp();
    const section = await rolesSection();
    const form = await within(section).findByRole('form', { name: 'Add role' });
    const add = within(form).getByRole('button', { name: 'Add role' });
    const users = within(form).getByLabelText('Number of users');

    // A blank title sends nothing.
    await user.click(add);
    expect(within(form).getByText('Enter a role title')).toBeInTheDocument();
    expect(within(form).getByLabelText('Title')).toBeInvalid();
    expect(api.sent('POST /api/ssp/roles')).toHaveLength(0);

    await user.type(within(form).getByLabelText('Title'), 'Admin');
    for (const bad of ['-1', '1.5', 'abc', '1000001']) {
      await user.clear(users);
      await user.type(users, bad);
      await user.click(add);
      expect(
        within(form).getByText('Enter a whole number from 0 to 1,000,000'),
      ).toBeInTheDocument();
    }
    expect(api.sent('POST /api/ssp/roles')).toHaveLength(0);

    // "0" passes.
    await user.clear(users);
    await user.type(users, '0');
    await user.click(add);
    const posts = await api.waitForCall('POST /api/ssp/roles');
    expect(posts[0]?.body).toMatchObject({ title: 'Admin', userCount: 0 });
  });

  it('edit and remove', async () => {
    const user = userEvent.setup();
    const api = rolesApi([makeRole('r1', { title: 'Administrator', userCount: 2 })], {});
    renderSsp();
    const section = await rolesSection();
    const table = await within(section).findByRole('table');

    // Edit opens the form prefilled; nothing changed means nothing to save.
    await user.click(within(table).getByRole('button', { name: 'Edit' }));
    const form = within(section).getByRole('form', { name: 'Edit role' });
    expect(within(form).getByLabelText('Title')).toHaveValue('Administrator');
    expect(within(form).getByLabelText('Number of users')).toHaveValue('2');
    expect(within(form).getByRole('button', { name: 'Save role' })).toBeDisabled();

    // Cancel drops the draft.
    await user.type(within(form).getByLabelText('Person'), 'Pat');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(within(section).queryByRole('form', { name: 'Edit role' })).not.toBeInTheDocument();

    // Only the changed keys are sent (a blank person stays null, so it is no change).
    await user.click(within(table).getByRole('button', { name: 'Edit' }));
    const again = within(section).getByRole('form', { name: 'Edit role' });
    expect(within(again).getByLabelText('Person')).toHaveValue('');
    await user.type(within(again).getByLabelText('Person'), 'Pat');
    await user.clear(within(again).getByLabelText('Number of users'));
    await user.type(within(again).getByLabelText('Number of users'), '4');
    await user.click(within(again).getByRole('button', { name: 'Save role' }));
    const patches = await api.waitForCall('PATCH /api/ssp/roles/r1');
    expect(patches[0]?.body).toEqual({ person: 'Pat', userCount: 4 });
    await api.waitForCall('GET /api/ssp/roles', 2);
    expect(within(section).queryByRole('form', { name: 'Edit role' })).not.toBeInTheDocument();
    expect(await within(section).findByText('Pat')).toBeInTheDocument();

    // A 404 on edit shows the removed text and reloads.
    api.defer('PATCH /api/ssp/roles/r1').answer(apiError(404, 'not_found'));
    await user.click(within(section).getByRole('button', { name: 'Edit' }));
    const third = within(section).getByRole('form', { name: 'Edit role' });
    await user.type(within(third).getByLabelText('Person'), 'x');
    await user.click(within(third).getByRole('button', { name: 'Save role' }));
    expect(await within(section).findByText(REMOVED)).toBeInTheDocument();
    await api.waitForCall('GET /api/ssp/roles', 3);

    // Remove needs Confirm; Cancel sends nothing.
    await user.click(within(section).getByRole('button', { name: 'Remove' }));
    await user.click(within(section).getByRole('button', { name: 'Cancel' }));
    expect(api.sent('DELETE /api/ssp/roles/r1')).toHaveLength(0);
    await user.click(within(section).getByRole('button', { name: 'Remove' }));
    expect(within(section).getByText('Remove Administrator?')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Confirm remove' }));
    expect(await api.waitForCall('DELETE /api/ssp/roles/r1')).toHaveLength(1);
    await api.waitForCall('GET /api/ssp/roles', 4);
    expect(within(section).queryByRole('table')).not.toBeInTheDocument();
    expect(within(section).getByText('No roles yet.')).toBeInTheDocument();
  });

  it('shows a 404 on remove as the removed text and reloads', async () => {
    const user = userEvent.setup();
    const api = rolesApi([makeRole('r1', { title: 'Administrator' })], {
      'DELETE /api/ssp/roles/r1': () => apiError(404, 'not_found'),
    });
    renderSsp();
    const section = await rolesSection();
    await user.click(await within(section).findByRole('button', { name: 'Remove' }));
    await user.click(within(section).getByRole('button', { name: 'Confirm remove' }));
    await api.waitForCall('DELETE /api/ssp/roles/r1');
    expect(await within(section).findByText(REMOVED)).toBeInTheDocument();
    await api.waitForCall('GET /api/ssp/roles', 2);
  });

  it('shows a server field error on a role', async () => {
    const user = userEvent.setup();
    const api = rolesApi([], {
      'POST /api/ssp/roles': () =>
        apiError(400, 'validation_failed', 'Invalid', [{ path: ['title'], message: 'Too long' }]),
    });
    renderSsp();
    const form = await screen.findByRole('form', { name: 'Add role' });
    await user.type(within(form).getByLabelText('Title'), 'Admin');
    await user.click(within(form).getByRole('button', { name: 'Add role' }));
    expect(await within(form).findByText('Too long')).toBeInTheDocument();
    expect(within(form).getByLabelText('Title')).toBeInvalid();
    expect(api.sent('POST /api/ssp/roles')).toHaveLength(1);
  });

  it('contributor edits', async () => {
    const user = userEvent.setup();
    const api = rolesApi([], {}, 'contributor');
    renderSsp();
    const form = await screen.findByRole('form', { name: 'Add role' });
    await user.type(within(form).getByLabelText('Title'), 'Operator');
    await user.click(within(form).getByRole('button', { name: 'Add role' }));
    const posts = await api.waitForCall('POST /api/ssp/roles');
    expect(posts[0]?.body).toMatchObject({ title: 'Operator', userCount: 0, privileged: false });
  });
});
