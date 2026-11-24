import { loadCatalog, type Requirement } from '@rampart/catalog';
import { evaluateAssessment } from '@rampart/rules';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

// Each wait for the app may take up to 5 s, for a full-app render on a loaded CI runner. The
// test timeout sits above that (the 5 s default would equal it), so a wait that never succeeds
// fails with its own message and the DOM instead of a bare "Test timed out", and a test whose
// few waits are each slow still finishes. It only bounds a failing test; a passing one takes
// well under a second.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const catalog = loadCatalog();
const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const AT = '2026-11-23T10:00:00.000Z';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

const target = catalog.requirements.find((r) => r.id === 'AC.L2-3.1.1') as Requirement;
const mfa = catalog.requirements.find((r) => r.id === 'IA.L2-3.5.3') as Requirement;
const first = target.objectives[0];
if (!first) throw new Error('catalog');

/** Everything Met except 3.5.3. Records every request that is not a GET. */
function fakeApi() {
  const writes: { method: string; path: string }[] = [];
  const input = {
    objectiveResults: catalog.requirements.flatMap((r) =>
      r.objectives.map((o) => ({
        objectiveId: o.id,
        // 3.5.3 is Not Met, so its implementation level changes the score.
        status: r.id === mfa.id ? ('not_met' as const) : ('met' as const),
      })),
    ),
    implementationLevels: { [mfa.id]: 'none' as const },
  };
  const view = {
    assessment: {
      id: 'a-1',
      type: 'self',
      conditionalStatusDate: null,
      catalogVersion: 'v',
      updatedAt: AT,
    },
    objectiveResults: input.objectiveResults.map((r) => ({
      ...r,
      note: null,
      updatedAt: AT,
      updatedBy: { id: 'u-1', displayName: 'Ada Admin' },
    })),
    requirementStates: [
      {
        requirementId: mfa.id,
        implementationLevel: 'none',
        implementationStatement: null,
        owner: null,
        updatedAt: AT,
      },
    ],
    evaluation: evaluateAssessment(catalog, input),
    closeout: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (method !== 'GET') writes.push({ method, path });
      if (path === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }));
      if (path === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      if (path === '/api/users') return Promise.resolve(json(200, { users: [] }));
      if (path === '/api/assessment') return Promise.resolve(json(200, view));
      return Promise.resolve(json(404, { error: { code: 'not_found', message: 'x' } }));
    }),
  );
  return { writes, savedScore: view.evaluation.score };
}

function mount(requirement: Requirement) {
  return render(
    <MemoryRouter
      initialEntries={[`/assessment?family=${requirement.family}&req=${requirement.id}`]}
    >
      <AuthedApp />
    </MemoryRouter>,
  );
}
async function ready(requirement: Requirement) {
  await screen.findByRole('heading', { level: 2, name: requirement.id });
  await waitFor(() => {
    expect(screen.getByTestId('score-value')).not.toHaveTextContent('—');
  });
}
const status = (id: string) => screen.getByRole('radiogroup', { name: `Status for ${id}` });
const score = () => screen.getByTestId('score-value');
const savedText = (s: { kind: string; score?: number }) =>
  s.kind === 'scored' ? String(s.score) : '—';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what-if mode', () => {
  it('sends no request for a status or level change, and shows the what-if score and delta', async () => {
    const api = fakeApi();
    mount(target);
    await ready(target);
    const before = score().textContent;
    expect(screen.queryByText('What-if — not saved')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try changes' }));
    const notice = screen.getByText('What-if — not saved');
    expect(notice).toBeInTheDocument();
    await userEvent.click(within(status(first.id)).getByRole('radio', { name: 'Not Met' }));

    expect(api.writes).toEqual([]);
    expect(score().textContent).not.toBe(before);
    const panel = screen.getByRole('region', { name: 'SPRS score' });
    expect(panel).toHaveTextContent(/−\d+/);
    expect(panel).toHaveTextContent('1 requirement changed');
    // The list marks the changed requirement.
    const link = within(screen.getByRole('navigation', { name: 'Requirements' })).getByRole(
      'link',
      {
        current: true,
      },
    );
    expect(link).toHaveTextContent('what-if');
    expect(link).toHaveTextContent('Not Met');
    expect(api.writes).toEqual([]);
  });

  it('level changes stay local too, and other edits are disabled', async () => {
    const api = fakeApi();
    mount(mfa);
    await ready(mfa);
    await userEvent.click(screen.getByRole('button', { name: 'Try changes' }));
    const level = screen.getByRole('combobox', { name: 'Implementation level' });
    expect(level).toBeEnabled();
    await userEvent.selectOptions(level, 'partial');
    expect(api.writes).toEqual([]);
    expect(screen.getByRole('region', { name: 'SPRS score' })).toHaveTextContent(/Change \+\d+/);
    expect(level).toHaveValue('partial');

    expect(screen.getByRole('textbox', { name: 'Implementation statement' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Owner' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save statement' })).toBeDisabled();
    for (const objective of mfa.objectives) {
      const row = screen.getByRole('listitem', { name: objective.id });
      expect(within(row).getByRole('textbox')).toBeDisabled();
      expect(within(row).getByRole('button', { name: 'Save note' })).toBeDisabled();
    }
  });

  it('Exit discards the changes', async () => {
    fakeApi();
    mount(target);
    await ready(target);
    const before = score().textContent;
    await userEvent.click(screen.getByRole('button', { name: 'Try changes' }));
    await userEvent.click(within(status(first.id)).getByRole('radio', { name: 'Not Met' }));
    expect(score().textContent).not.toBe(before);
    await userEvent.click(screen.getByRole('button', { name: 'Exit what-if' }));
    expect(score()).toHaveTextContent(before);
    expect(screen.queryByText('What-if — not saved')).not.toBeInTheDocument();
    expect(within(status(first.id)).getByRole('radio', { name: 'Met' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Implementation statement' })).toBeEnabled();
  });

  it('leaving the page discards the changes', async () => {
    const api = fakeApi();
    const first1 = mount(target);
    await ready(target);
    const before = score().textContent;
    await userEvent.click(screen.getByRole('button', { name: 'Try changes' }));
    await userEvent.click(within(status(first.id)).getByRole('radio', { name: 'Not Met' }));
    first1.unmount();
    mount(target);
    await ready(target);
    expect(screen.queryByText('What-if — not saved')).not.toBeInTheDocument();
    expect(score()).toHaveTextContent(before);
    expect(within(status(first.id)).getByRole('radio', { name: 'Met' })).toBeChecked();
    expect(api.writes).toEqual([]);
    expect(savedText(api.savedScore)).toBe(before);
  });
});
