import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

// Each wait for the app may take up to 5 s (a full-app render on a loaded runner). The test
// timeout sits above that, so a wait that never succeeds fails with its own message and the DOM
// instead of a bare "Test timed out". It only bounds a failing test.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const AT = '2026-11-24T10:00:00.000Z';
const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const OWNER_ID = '3f0c8d9e-1b2a-4c5d-8e7f-0a1b2c3d4e5f';
const ELIGIBLE = { eligible: true };

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    requirementId: 'AC.L2-3.1.7',
    status: 'open',
    plan: 'Replace the VPN module',
    due: '2026-12-01',
    milestones: [],
    owner: null,
    createdAt: AT,
    createdBy: { id: 'u-1', displayName: 'Ada Admin' },
    updatedAt: AT,
    closeout: null,
    requirementStatus: 'not_met',
    eligibility: ELIGIBLE,
    daysToDue: 7,
    overdue: false,
    dueAfterDeadline: false,
    readyToClose: false,
    ...over,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fake api; `write` answers POST and PATCH calls to /api/poam. */
function fakeApi(
  parts: { items?: unknown[]; candidates?: unknown[] },
  write: (call: Call) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (input === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }));
      if (input === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      if (input === '/api/users')
        return Promise.resolve(
          json(200, {
            users: [
              {
                id: OWNER_ID,
                email: 'kim@example.com',
                displayName: 'Kim Owner',
                role: 'contributor',
                active: true,
                createdAt: AT,
              },
            ],
          }),
        );
      if (input === '/api/poam' && method === 'GET')
        return Promise.resolve(
          json(200, {
            items: parts.items ?? [],
            candidates: parts.candidates ?? [],
            closeout: null,
            confirmer: 'organization',
          }),
        );
      const call: Call = {
        method,
        path: input,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      return Promise.resolve(write(call));
    }),
  );
  return { calls };
}

async function openCreateForm(user: ReturnType<typeof userEvent.setup>) {
  render(
    <MemoryRouter initialEntries={['/poam']}>
      <AuthedApp />
    </MemoryRouter>,
  );
  const list = await screen.findByRole('list', { name: 'Candidates' });
  await user.click(within(list).getByRole('button', { name: 'Add to POA&M' }));
  return screen.findByRole('form', { name: 'New POA&M item' });
}

const CANDIDATES = [{ requirementId: 'AC.L2-3.1.7', eligibility: ELIGIBLE }];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('create', () => {
  it('an empty plan sends nothing and says so', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ candidates: CANDIDATES }, () => json(201, { item: item() }));
    const form = await openCreateForm(user);
    await user.type(within(form).getByLabelText('Due date'), '2026-12-01');
    await user.type(within(form).getByLabelText('Plan'), '   ');
    await user.click(within(form).getByRole('button', { name: 'Save item' }));
    expect(await within(form).findByText('Enter the plan of action.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('a malformed due date sends nothing', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ candidates: CANDIDATES }, () => json(201, { item: item() }));
    const form = await openCreateForm(user);
    await user.type(within(form).getByLabelText('Plan'), 'Fix it');
    await user.type(within(form).getByLabelText('Due date'), '2026-13-40');
    await user.click(within(form).getByRole('button', { name: 'Save item' }));
    expect(await within(form).findByText('Enter a real date as YYYY-MM-DD.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('a milestone due after the item due sends nothing', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ candidates: CANDIDATES }, () => json(201, { item: item() }));
    const form = await openCreateForm(user);
    await user.type(within(form).getByLabelText('Plan'), 'Fix it');
    await user.type(within(form).getByLabelText('Due date'), '2026-12-01');
    await user.click(within(form).getByRole('button', { name: 'Add milestone' }));
    await user.type(within(form).getByLabelText('Milestone 1 title'), 'Order hardware');
    await user.type(within(form).getByLabelText('Milestone 1 due'), '2026-12-02');
    await user.click(within(form).getByRole('button', { name: 'Save item' }));
    expect(
      await within(form).findByText("This milestone is due after the item's due date."),
    ).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('a valid form sends the exact body once on a double click', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ candidates: CANDIDATES }, () => json(201, { item: item() }));
    const form = await openCreateForm(user);
    await user.type(within(form).getByLabelText('Plan'), '  Replace the VPN module ');
    await user.type(within(form).getByLabelText('Due date'), '2026-12-01');
    await user.selectOptions(within(form).getByLabelText('Owner'), 'Kim Owner');
    await user.click(within(form).getByRole('button', { name: 'Add milestone' }));
    await user.type(within(form).getByLabelText('Milestone 1 title'), 'Order hardware');
    await user.type(within(form).getByLabelText('Milestone 1 due'), '2026-11-30');
    await user.click(within(form).getByRole('button', { name: 'Add milestone' }));
    await user.type(within(form).getByLabelText('Milestone 2 title'), 'Install it');
    await user.type(within(form).getByLabelText('Milestone 2 due'), '2026-12-01');
    await user.dblClick(within(form).getByRole('button', { name: 'Save item' }));
    await waitFor(() => {
      expect(api.calls).toHaveLength(1);
    });
    expect(api.calls[0]).toEqual({
      method: 'POST',
      path: '/api/poam',
      body: {
        requirementId: 'AC.L2-3.1.7',
        plan: 'Replace the VPN module',
        due: '2026-12-01',
        ownerId: OWNER_ID,
        milestones: [
          { title: 'Order hardware', due: '2026-11-30', doneOn: null },
          { title: 'Install it', due: '2026-12-01', doneOn: null },
        ],
      },
    });
    // The form closes once saved.
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'New POA&M item' })).toBeNull();
    });
    expect(api.calls).toHaveLength(1);
  });

  it('a 409 poam_ineligible shows the reasons with their citations', async () => {
    const user = userEvent.setup();
    fakeApi({ candidates: CANDIDATES }, () =>
      json(409, {
        error: {
          code: 'poam_ineligible',
          message: 'This requirement is not eligible for a POA&M.',
          requestId: 'req-9',
          details: {
            reasons: [
              { code: 'exceeds_point_limit', citation: '32 CFR 170.21(a)(2)(i)' },
              { code: 'not_not_met', citation: '32 CFR 170.24(c)(2)(i)(B)(6)' },
            ],
          },
        },
      }),
    );
    const form = await openCreateForm(user);
    await user.type(within(form).getByLabelText('Plan'), 'Fix it');
    await user.type(within(form).getByLabelText('Due date'), '2026-12-01');
    await user.click(within(form).getByRole('button', { name: 'Save item' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent("Worth more than 1 point, so it can't go on a POA&M");
    expect(alert).toHaveTextContent('32 CFR 170.21(a)(2)(i)');
    expect(alert).toHaveTextContent('Only Not Met requirements go on a POA&M');
    expect(alert).toHaveTextContent('32 CFR 170.24(c)(2)(i)(B)(6)');
    // The form stays open with the user's words.
    expect(within(form).getByLabelText('Plan')).toHaveValue('Fix it');
  });

  it('editing an item sends only what changed', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ items: [item()] }, () =>
      json(200, { item: item({ due: '2026-12-15' }) }),
    );
    render(
      <MemoryRouter initialEntries={['/poam']}>
        <AuthedApp />
      </MemoryRouter>,
    );
    const list = await screen.findByRole('list', { name: 'POA&M items' });
    await user.click(within(list).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByRole('form', { name: 'Edit POA&M item' });
    const due = within(form).getByLabelText('Due date');
    await user.clear(due);
    await user.type(due, '2026-12-15');
    await user.click(within(form).getByRole('button', { name: 'Save item' }));
    await waitFor(() => {
      expect(api.calls).toHaveLength(1);
    });
    expect(api.calls[0]).toEqual({
      method: 'PATCH',
      path: '/api/poam/p-1',
      body: { due: '2026-12-15' },
    });
  });

  it('a milestone edit that only moves text across a field boundary is still sent', async () => {
    // Joined without separators, both lists read "Order2026-11-302026-11-25Install2026-12-01".
    const user = userEvent.setup();
    const milestones = [
      { title: 'Order', due: '2026-11-30', doneOn: null },
      { title: '2026-11-25Install', due: '2026-12-01', doneOn: null },
    ];
    const api = fakeApi({ items: [item({ milestones })] }, () => json(200, { item: item() }));
    render(
      <MemoryRouter initialEntries={['/poam']}>
        <AuthedApp />
      </MemoryRouter>,
    );
    const list = await screen.findByRole('list', { name: 'POA&M items' });
    await user.click(within(list).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByRole('form', { name: 'Edit POA&M item' });
    await user.type(within(form).getByLabelText('Milestone 1 done on (optional)'), '2026-11-25');
    const title = within(form).getByLabelText('Milestone 2 title');
    await user.clear(title);
    await user.type(title, 'Install');
    await user.click(within(form).getByRole('button', { name: 'Save item' }));
    await waitFor(() => {
      expect(api.calls).toHaveLength(1);
    });
    expect(api.calls[0]).toEqual({
      method: 'PATCH',
      path: '/api/poam/p-1',
      body: {
        milestones: [
          { title: 'Order', due: '2026-11-30', doneOn: '2026-11-25' },
          { title: 'Install', due: '2026-12-01', doneOn: null },
        ],
      },
    });
  });

  it('saving unchanged milestones sends nothing', async () => {
    const user = userEvent.setup();
    const milestones = [{ title: 'Order', due: '2026-11-30', doneOn: null }];
    const api = fakeApi({ items: [item({ milestones })] }, () => json(200, { item: item() }));
    render(
      <MemoryRouter initialEntries={['/poam']}>
        <AuthedApp />
      </MemoryRouter>,
    );
    const list = await screen.findByRole('list', { name: 'POA&M items' });
    await user.click(within(list).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByRole('form', { name: 'Edit POA&M item' });
    await user.click(within(form).getByRole('button', { name: 'Save item' }));
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Edit POA&M item' })).toBeNull();
    });
    expect(api.calls).toHaveLength(0);
  });
});
