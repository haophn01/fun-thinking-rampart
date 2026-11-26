import { loadCatalog, type Requirement } from '@rampart/catalog';
import { evaluateAssessment, type ObjectiveStatus } from '@rampart/rules';
import { configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const catalog = loadCatalog();
const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const AT = '2026-11-23T10:00:00.000Z';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

const target = catalog.requirements.find((r) => r.id === 'AC.L2-3.1.1') as Requirement;
const other = catalog.requirements.find(
  (r) => r.family === target.family && r.id !== target.id,
) as Requirement;

interface Call {
  method: string;
  path: string;
  body: unknown;
}
interface Setup {
  /** Status given to every objective of every requirement; null stores no results at all. */
  status?: ObjectiveStatus | null;
  states?: Record<string, Record<string, unknown>>;
  patch?: (call: Call) => Response | Promise<Response>;
}

function fakeApi(setup: Setup = {}) {
  const calls: Call[] = [];
  const states = new Map<string, Record<string, unknown>>(Object.entries(setup.states ?? {}));
  const results =
    setup.status === null
      ? []
      : catalog.requirements.flatMap((r) =>
          r.objectives.map((o) => ({
            objectiveId: o.id,
            status: setup.status ?? 'met',
            note: null,
            updatedAt: AT,
            updatedBy: { id: 'u-1', displayName: 'Ada Admin' },
          })),
        );
  const evaluation = () =>
    evaluateAssessment(catalog, {
      objectiveResults: results.map((r) => ({ objectiveId: r.objectiveId, status: r.status })),
      implementationLevels: {},
    });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body =
        typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      if (input === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }));
      if (input === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      if (input === '/api/users') return Promise.resolve(json(200, { users: [] }));
      if (input === '/api/assessment')
        return Promise.resolve(
          json(200, {
            assessment: {
              id: 'a-1',
              type: 'self',
              conditionalStatusDate: null,
              catalogVersion: 'v',
              updatedAt: AT,
            },
            objectiveResults: results,
            requirementStates: [...states.values()],
            evaluation: evaluation(),
            closeout: null,
          }),
        );
      const call = { method, path: input, body };
      calls.push(call);
      const match = /^\/api\/assessment\/requirements\/(.+)$/.exec(input);
      if (method === 'PATCH' && match) {
        const apply = () => {
          const id = decodeURIComponent(match[1] ?? '');
          const next = {
            requirementId: id,
            implementationLevel: null,
            implementationStatement: null,
            owner: null,
            plannedImplementation: null,
            naRationale: null,
            updatedAt: AT,
            ...states.get(id),
            ...body,
          };
          states.set(id, next);
          return json(200, { requirementState: next, evaluation: evaluation() });
        };
        return setup.patch
          ? Promise.resolve(setup.patch(call)).then((r) => (r.ok ? apply() : r))
          : Promise.resolve(apply());
      }
      return Promise.resolve(json(404, { error: { code: 'not_found', message: 'x' } }));
    }),
  );
  return { writes: () => calls.filter((c) => c.method !== 'GET') };
}

async function open(requirement: Requirement) {
  render(
    <MemoryRouter
      initialEntries={[`/assessment?family=${requirement.family}&req=${requirement.id}`]}
    >
      <AuthedApp />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 2, name: requirement.id });
}
const planned = () => screen.getByRole('textbox', { name: 'Planned implementation' });
const rationale = () => screen.getByRole('textbox', { name: 'N/A rationale' });
const savePlanned = () => screen.getByRole('button', { name: 'Save planned implementation' });
const saveRationale = () => screen.getByRole('button', { name: 'Save N/A rationale' });

function stateOf(id: string, extra: Record<string, unknown>) {
  return {
    [id]: {
      requirementId: id,
      implementationLevel: null,
      implementationStatement: null,
      owner: null,
      updatedAt: AT,
      ...extra,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('planned and N/A save', () => {
  it('loads each stored value, saves only its own key, and sends null when blanked', async () => {
    const api = fakeApi({
      states: stateOf(target.id, { plannedImplementation: 'Q3 rollout', naRationale: 'No CUI' }),
    });
    await open(target);
    expect(planned()).toHaveValue('Q3 rollout');
    expect(rationale()).toHaveValue('No CUI');
    expect(planned()).toHaveAttribute('maxlength', '20000');
    expect(rationale()).toHaveAttribute('maxlength', '4000');
    expect(
      screen.getByText('What will be done, and when. The SSP prints it for Not Met requirements.'),
    ).toBeInTheDocument();
    expect(screen.getByText("Why the objectives marked N/A don't apply.")).toBeInTheDocument();

    await userEvent.type(planned(), ' and more');
    await userEvent.click(savePlanned());
    await waitFor(() => {
      expect(api.writes()).toHaveLength(1);
    });
    expect(api.writes()[0]).toEqual({
      method: 'PATCH',
      path: '/api/assessment/requirements/AC.L2-3.1.1',
      body: { plannedImplementation: 'Q3 rollout and more' },
    });

    await userEvent.clear(rationale());
    await userEvent.click(saveRationale());
    await waitFor(() => {
      expect(api.writes()).toHaveLength(2);
    });
    expect(api.writes()[1]?.body).toEqual({ naRationale: null });

    await userEvent.clear(planned());
    await userEvent.type(planned(), '   ');
    await userEvent.click(savePlanned());
    await waitFor(() => {
      expect(api.writes()).toHaveLength(3);
    });
    expect(api.writes()[2]?.body).toEqual({ plannedImplementation: null });
  });
});

describe('save gating', () => {
  it('is disabled when the trimmed draft equals the stored value, and while a patch is pending', async () => {
    let release: () => void = () => undefined;
    const api = fakeApi({
      states: stateOf(target.id, { plannedImplementation: 'Same', naRationale: null }),
      patch: () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(json(200));
          };
        }),
    });
    await open(target);
    expect(savePlanned()).toBeDisabled();
    expect(saveRationale()).toBeDisabled();
    await userEvent.type(planned(), '  ');
    expect(savePlanned()).toBeDisabled();
    await userEvent.type(rationale(), 'Why');
    expect(saveRationale()).toBeEnabled();
    await userEvent.click(saveRationale());
    await waitFor(() => {
      expect(api.writes()).toHaveLength(1);
    });
    await userEvent.type(planned(), 'z');
    expect(savePlanned()).toBeDisabled();
    expect(saveRationale()).toBeDisabled();
    release();
    await waitFor(() => {
      expect(saveRationale()).toBeDisabled();
    });
    expect(rationale()).toHaveValue('Why');
  });

  it('is disabled in what-if', async () => {
    fakeApi();
    await open(target);
    await userEvent.type(planned(), 'x');
    expect(savePlanned()).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Try changes' }));
    expect(savePlanned()).toBeDisabled();
    expect(saveRationale()).toBeDisabled();
  });
});

describe('older rows and switching', () => {
  it('reads empty when the row has neither key, and resets both drafts on switching requirement', async () => {
    fakeApi({ states: stateOf(target.id, {}) });
    await open(target);
    expect(planned()).toHaveValue('');
    expect(rationale()).toHaveValue('');
    await userEvent.type(planned(), 'draft one');
    await userEvent.type(rationale(), 'draft two');
    await userEvent.click(screen.getByRole('link', { name: 'Back to requirements' }));
    await userEvent.click(
      screen
        .getAllByRole('link')
        .find((l) => l.getAttribute('href')?.includes(encodeURIComponent(other.id))) as HTMLElement,
    );
    await screen.findByRole('heading', { level: 2, name: other.id });
    expect(planned()).toHaveValue('');
    expect(rationale()).toHaveValue('');
  });
});

describe('SSP status', () => {
  const cases: [string, ObjectiveStatus | null, string][] = [
    ['met', 'met', 'SSP status: Implemented'],
    ['all N/A', 'na', 'SSP status: Not applicable'],
    ['not met', 'not_met', 'SSP status: Planned to be implemented'],
    ['no outcome', null, 'SSP status: Not yet assessed'],
  ];
  it.each(cases)('reads correctly for %s', async (_name, status, text) => {
    fakeApi({ status });
    await open(target);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('save failure', () => {
  it('shows the statement save error and keeps the draft', async () => {
    const api = fakeApi({
      patch: () =>
        json(500, {
          error: { code: 'internal_error', message: 'Could not save', requestId: 'r-9' },
        }),
    });
    await open(target);
    await userEvent.type(planned(), 'Keep me');
    await userEvent.click(savePlanned());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That change was not saved');
    expect(alert).toHaveTextContent('Could not save');
    expect(alert).toHaveTextContent('r-9');
    expect(api.writes()).toHaveLength(1);
    expect(planned()).toHaveValue('Keep me');
    expect(savePlanned()).toBeEnabled();
  });
});
