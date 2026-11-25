import { configure, render, screen, within } from '@testing-library/react';
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

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

const ELIGIBLE = { eligible: true };
const BARRED = {
  eligible: false,
  reasons: [{ code: 'barred', citation: '32 CFR 170.21(a)(2)(iii)' }],
};

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

interface ViewParts {
  items?: unknown[];
  candidates?: unknown[];
  closeout?: unknown;
  confirmer?: 'organization' | 'c3pao';
}
function view(parts: ViewParts = {}) {
  return {
    items: parts.items ?? [],
    candidates: parts.candidates ?? [],
    closeout: parts.closeout ?? null,
    confirmer: parts.confirmer ?? 'organization',
  };
}

function fakeApi(poam: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      if (input === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }));
      if (input === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      if (input === '/api/users') return Promise.resolve(json(200, { users: [] }));
      if (input === '/api/poam') return Promise.resolve(json(200, poam));
      return Promise.resolve(json(404, { error: { code: 'not_found', message: 'nf' } }));
    }),
  );
}

async function renderPage() {
  render(
    <MemoryRouter initialEntries={['/poam']}>
      <AuthedApp />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'POA&M' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('countdowns', () => {
  it('without a Conditional Status Date the clock says how to start it', async () => {
    fakeApi(view());
    await renderPage();
    const clock = await screen.findByRole('region', { name: 'Closeout clock' });
    expect(clock).toHaveTextContent(
      'Set the Conditional Status Date in Settings to start the 180-day clock',
    );
    expect(clock).toHaveTextContent('Your organization');
  });

  it('with 180 days left the clock shows the deadline and the days, and the confirmer', async () => {
    fakeApi(
      view({
        closeout: {
          conditionalStatusDate: '2026-11-24',
          deadline: '2027-05-23',
          daysRemaining: 180,
          expired: false,
        },
        confirmer: 'c3pao',
      }),
    );
    await renderPage();
    const clock = await screen.findByRole('region', { name: 'Closeout clock' });
    expect(await within(clock).findByText(/180 days left/)).toBeInTheDocument();
    expect(clock).toHaveTextContent('2027-05-23');
    expect(clock).toHaveTextContent('An authorized C3PAO');
  });

  it('when expired the clock says the deadline passed N days ago', async () => {
    fakeApi(
      view({
        closeout: {
          conditionalStatusDate: '2026-01-01',
          deadline: '2026-06-30',
          daysRemaining: -12,
          expired: true,
        },
      }),
    );
    await renderPage();
    const clock = await screen.findByRole('region', { name: 'Closeout clock' });
    expect(await within(clock).findByText(/passed 12 days ago/)).toBeInTheDocument();
  });

  it('an item is overdue by 1 day at -1, due today at 0, and has 3 days left at +3', async () => {
    fakeApi(
      view({
        items: [
          item({ id: 'a', requirementId: 'AC.L2-3.1.1', daysToDue: -1, overdue: true }),
          item({ id: 'b', requirementId: 'AC.L2-3.1.2', daysToDue: 0 }),
          item({ id: 'c', requirementId: 'AC.L2-3.1.3', daysToDue: 3 }),
        ],
      }),
    );
    await renderPage();
    const list = await screen.findByRole('list', { name: 'POA&M items' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Overdue by 1 day');
    expect(rows[1]).toHaveTextContent('Due today');
    expect(rows[2]).toHaveTextContent('3 days left');
  });

  it('shows the flags: due after the deadline, no longer eligible, ready for closeout', async () => {
    fakeApi(
      view({
        items: [
          item({ id: 'a', requirementId: 'AC.L2-3.1.1', dueAfterDeadline: true }),
          item({
            id: 'b',
            requirementId: 'AC.L2-3.1.2',
            eligibility: {
              eligible: false,
              reasons: [{ code: 'exceeds_point_limit', citation: 'c' }],
            },
          }),
          item({
            id: 'c',
            requirementId: 'AC.L2-3.1.3',
            requirementStatus: 'met',
            readyToClose: true,
          }),
        ],
      }),
    );
    await renderPage();
    const list = await screen.findByRole('list', { name: 'POA&M items' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Due after the closeout deadline');
    expect(rows[1]).toHaveTextContent('No longer eligible');
    expect(rows[2]).toHaveTextContent('Ready for closeout');
    expect(rows[2]).not.toHaveTextContent('No longer eligible');
  });
});

describe('candidates', () => {
  it('a barred 3.1.20 shows a disabled Add with its reason and citation; an eligible one opens the form preselected', async () => {
    const user = userEvent.setup();
    fakeApi(
      view({
        candidates: [
          { requirementId: 'AC.L2-3.1.20', eligibility: BARRED },
          { requirementId: 'AC.L2-3.1.7', eligibility: ELIGIBLE },
        ],
      }),
    );
    await renderPage();
    const list = await screen.findByRole('list', { name: 'Candidates' });
    const [barred, eligible] = within(list).getAllByRole('listitem');
    if (!barred || !eligible) throw new Error('two candidates');

    expect(barred).toHaveTextContent('AC.L2-3.1.20');
    expect(within(barred).getByRole('button', { name: 'Add to POA&M' })).toBeDisabled();
    expect(barred).toHaveTextContent('This requirement can never go on a POA&M');
    expect(barred).toHaveTextContent('32 CFR 170.21(a)(2)(iii)');

    const add = within(eligible).getByRole('button', { name: 'Add to POA&M' });
    expect(add).toBeEnabled();
    expect(screen.queryByRole('form', { name: 'New POA&M item' })).toBeNull();
    await user.click(add);
    const form = await screen.findByRole('form', { name: 'New POA&M item' });
    expect(form).toHaveTextContent('AC.L2-3.1.7');
  });
});
