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
const CONTRIBUTOR = {
  id: 'u-2',
  email: 'kim@example.com',
  displayName: 'Kim',
  role: 'contributor',
};

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
    eligibility: { eligible: true },
    daysToDue: 7,
    overdue: false,
    dueAfterDeadline: false,
    readyToClose: false,
    ...over,
  };
}

const READY = { requirementStatus: 'met', readyToClose: true };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(
  who: typeof ADMIN | typeof CONTRIBUTOR,
  items: unknown[],
  confirmer: 'organization' | 'c3pao',
  write: (call: Call) => Response = () => json(200, { item: item() }),
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (input === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: who, csrfToken: 'tok' }));
      if (input === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      if (input === '/api/users') return Promise.resolve(json(200, { users: [] }));
      if (input === '/api/poam' && method === 'GET')
        return Promise.resolve(json(200, { items, candidates: [], closeout: null, confirmer }));
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

async function renderPage(listName = 'POA&M items') {
  render(
    <MemoryRouter initialEntries={['/poam']}>
      <AuthedApp />
    </MemoryRouter>,
  );
  const list = await screen.findByRole('list', { name: listName });
  return within(list).getAllByRole('listitem');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('closeout', () => {
  it('is hidden for contributors', async () => {
    fakeApi(CONTRIBUTOR, [item(READY)], 'organization');
    const [row] = await renderPage();
    expect(row).toHaveTextContent('Ready for closeout');
    expect(within(row as HTMLElement).queryByRole('button', { name: /close out/i })).toBeNull();
  });

  it('is disabled for an admin unless the item is ready to close', async () => {
    fakeApi(
      ADMIN,
      [item({ id: 'a', requirementId: 'AC.L2-3.1.1' }), item({ ...READY, id: 'b' })],
      'organization',
    );
    const rows = await renderPage();
    expect(
      within(rows[0] as HTMLElement).getByRole('button', { name: 'Close out' }),
    ).toBeDisabled();
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'Close out' })).toBeEnabled();
  });

  it('a self-assessment shows no C3PAO name, and the confirmer label says your organization', async () => {
    const user = userEvent.setup();
    const api = fakeApi(ADMIN, [item(READY)], 'organization');
    const [row] = await renderPage();
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Close out' }));
    const form = await screen.findByRole('form', { name: 'Close out AC.L2-3.1.7' });
    expect(form).toHaveTextContent('Confirmed by: Your organization');
    expect(within(form).queryByLabelText(/C3PAO name/)).toBeNull();
    await user.type(within(form).getByLabelText('Closed on'), '2026-11-24');
    await user.type(within(form).getByLabelText('Note (optional)'), 'Verified in the console.');
    await user.click(within(form).getByRole('button', { name: 'Record closeout' }));
    await waitFor(() => {
      expect(api.calls).toHaveLength(1);
    });
    expect(api.calls[0]).toEqual({
      method: 'POST',
      path: '/api/poam/p-1/closeout',
      body: { closedOn: '2026-11-24', note: 'Verified in the console.' },
    });
  });

  it('a C3PAO assessment requires the C3PAO name, and the label follows the type', async () => {
    const user = userEvent.setup();
    const api = fakeApi(ADMIN, [item(READY)], 'c3pao');
    const [row] = await renderPage();
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Close out' }));
    const form = await screen.findByRole('form', { name: 'Close out AC.L2-3.1.7' });
    expect(form).toHaveTextContent('Confirmed by: An authorized C3PAO');
    await user.type(within(form).getByLabelText('Closed on'), '2026-11-24');
    await user.click(within(form).getByRole('button', { name: 'Record closeout' }));
    expect(await within(form).findByText('Enter the C3PAO name.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);

    await user.type(within(form).getByLabelText('C3PAO name'), '  Acme Assessors ');
    await user.click(within(form).getByRole('button', { name: 'Record closeout' }));
    await waitFor(() => {
      expect(api.calls).toHaveLength(1);
    });
    expect(api.calls[0]?.body).toEqual({
      closedOn: '2026-11-24',
      note: null,
      c3paoName: 'Acme Assessors',
    });
  });

  it('a malformed closed-on date sends nothing', async () => {
    const user = userEvent.setup();
    const api = fakeApi(ADMIN, [item(READY)], 'organization');
    const [row] = await renderPage();
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Close out' }));
    const form = await screen.findByRole('form', { name: 'Close out AC.L2-3.1.7' });
    await user.type(within(form).getByLabelText('Closed on'), 'yesterday');
    await user.click(within(form).getByRole('button', { name: 'Record closeout' }));
    expect(await within(form).findByText('Enter a real date as YYYY-MM-DD.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('a closed item shows its closeout with who confirmed it', async () => {
    fakeApi(
      ADMIN,
      [
        item({
          status: 'closed',
          requirementStatus: 'met',
          daysToDue: 7,
          closeout: {
            closedOn: '2026-11-20',
            note: 'Done',
            confirmedBy: 'c3pao',
            c3paoName: 'Acme Assessors',
            recordedBy: { id: 'u-1', displayName: 'Ada Admin' },
            late: true,
          },
        }),
      ],
      'c3pao',
    );
    const [row] = await renderPage('Closed POA&M items');
    expect(row).toHaveTextContent('Closed on 2026-11-20');
    expect(row).toHaveTextContent('An authorized C3PAO');
    expect(row).toHaveTextContent('Acme Assessors');
    expect(row).toHaveTextContent('Closed after the closeout deadline');
    expect(within(row as HTMLElement).queryByRole('button', { name: 'Close out' })).toBeNull();
  });
});
