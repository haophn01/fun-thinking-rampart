import { loadCatalog, type Requirement } from '@rampart/catalog';
import { evaluateAssessment, type ObjectiveStatus } from '@rampart/rules';
import { configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

// The first render of the whole app is slow on a loaded machine.
configure({ asyncUtilTimeout: 5000 });

const catalog = loadCatalog();
const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

/** A view whose objective results come from `statusOf`; the evaluation is the real one. */
function makeView(
  statusOf: (requirement: Requirement, objectiveId: string) => ObjectiveStatus = () =>
    'not_assessed',
) {
  const objectiveResults = catalog.requirements.flatMap((r) =>
    r.objectives
      .filter((o) => statusOf(r, o.id) !== 'not_assessed')
      .map((o) => ({
        objectiveId: o.id,
        status: statusOf(r, o.id),
        note: null,
        updatedAt: '2026-11-23T10:00:00.000Z',
        updatedBy: { id: 'u-1', displayName: 'Ada Admin' },
      })),
  );
  const evaluation = evaluateAssessment(catalog, {
    objectiveResults: objectiveResults.map(({ objectiveId, status }) => ({ objectiveId, status })),
    implementationLevels: {},
  });
  return {
    assessment: {
      id: 'a-1',
      type: 'self',
      conditionalStatusDate: null,
      catalogVersion: catalog.version,
      updatedAt: '2026-11-23T10:00:00.000Z',
    },
    objectiveResults,
    requirementStates: [],
    evaluation,
    closeout: null,
  };
}

function fakeApi(view: () => Response | Promise<Response>) {
  let assessmentCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      if (input === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }));
      if (input === '/api/assessment') {
        assessmentCalls += 1;
        return Promise.resolve(view());
      }
      if (input === '/api/users') return Promise.resolve(json(200, { users: [] }));
      if (input === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      return Promise.resolve(json(404, { error: { code: 'not_found', message: 'x' } }));
    }),
  );
  return { assessmentCalls: () => assessmentCalls };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthedApp />
    </MemoryRouter>,
  );
}

const families = () => within(screen.getByRole('navigation', { name: 'Families' }));
const requirements = () => within(screen.getByRole('navigation', { name: 'Requirements' }));
/** Waits for the lists, which show once the view has loaded. */
const loaded = () => screen.findByRole('navigation', { name: 'Families' });
const acReqs = catalog.requirements.filter((r) => r.family === 'AC');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browse', () => {
  it('shows loading, then 14 families with counts and bars', async () => {
    let answer: (r: Response) => void = () => undefined;
    fakeApi(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderAt('/assessment');
    expect(await screen.findByText('Loading assessment…')).toBeInTheDocument();
    // AC: first requirement Not Met, second not assessed, the rest Met.
    answer(
      json(
        200,
        makeView((r) => {
          if (r.family !== 'AC') return 'not_assessed';
          if (r.id === acReqs[0]?.id) return 'not_met';
          return r.id === acReqs[1]?.id ? 'not_assessed' : 'met';
        }),
      ),
    );
    await loaded();
    const links = families().getAllByRole('link');
    expect(links).toHaveLength(14);
    const ac = links.find((l) => l.textContent.includes('Access Control')) as HTMLElement;
    expect(ac).toHaveTextContent('Met ' + String(acReqs.length - 2));
    expect(ac).toHaveTextContent('Not Met 1');
    expect(ac).toHaveTextContent('Not Assessed 1');
    expect(within(ac).getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      String(Math.round(((acReqs.length - 1) / acReqs.length) * 100)),
    );
  });

  it('picking a family lists its requirements in catalog order', async () => {
    fakeApi(() => json(200, makeView()));
    renderAt('/assessment');
    const sc = catalog.requirements.filter((r) => r.family === 'SC');
    await loaded();
    const scLink = families()
      .getAllByRole('link')
      .find((l) => l.textContent.includes('System and Communications')) as HTMLElement;
    await userEvent.click(scLink);
    const ids = requirements()
      .getAllByRole('link')
      .map((l) => l.getAttribute('data-requirement'));
    expect(ids).toEqual(sc.map((r) => r.id));
  });

  it('deep-links to a requirement', async () => {
    fakeApi(() => json(200, makeView()));
    const target = catalog.requirements.find((r) => r.family === 'SC') as Requirement;
    renderAt(`/assessment?family=SC&req=${target.id}`);
    expect(await screen.findByRole('heading', { level: 2, name: target.id })).toBeInTheDocument();
    expect(requirements().getByRole('link', { current: true })).toHaveAttribute(
      'data-requirement',
      target.id,
    );
  });

  it('falls back to the first family with nothing selected on unknown values', async () => {
    fakeApi(() => json(200, makeView()));
    const target = catalog.requirements.find((r) => r.family === 'SC') as Requirement;
    const a = renderAt('/assessment?family=ZZ&req=nonsense');
    await loaded();
    expect(families().getAllByRole('link')[0]).toHaveAttribute('aria-current', 'true');
    expect(requirements().getAllByRole('link')).toHaveLength(acReqs.length);
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    a.unmount();

    // A requirement from another family than the one shown is not selected.
    renderAt(`/assessment?family=AC&req=${target.id}`);
    await loaded();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
  });

  it('shows the message, request ID and Retry on an error, and Retry reloads', async () => {
    let fail = true;
    const api = fakeApi(() =>
      fail
        ? json(500, {
            error: { code: 'internal_error', message: 'Boom today', requestId: 'req-77' },
          })
        : json(200, makeView()),
    );
    renderAt('/assessment');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Boom today');
    expect(alert).toHaveTextContent('req-77');
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await loaded();
    expect(families().getAllByRole('link')).toHaveLength(14);
    expect(api.assessmentCalls()).toBe(2);
  });
});

describe('requirement detail', () => {
  async function open(requirement: Requirement) {
    renderAt(`/assessment?family=${requirement.family}&req=${requirement.id}`);
    return screen.findByRole('heading', { level: 2, name: requirement.id });
  }
  const pick = (test: (r: Requirement) => boolean) =>
    catalog.requirements.find(test) as Requirement;
  const points = (r: Requirement) => (r.scoring.kind === 'points' ? r.scoring : null);

  it.each([
    ['5 points', (r: Requirement) => points(r)?.points === 5 && !points(r)?.partialCredit],
    ['3 points', (r: Requirement) => points(r)?.points === 3],
    ['1 point', (r: Requirement) => points(r)?.points === 1],
    ['Prerequisite — no points', (r: Requirement) => r.scoring.kind === 'prerequisite'],
  ])('shows "%s" with the text and objectives', async (label, test) => {
    fakeApi(() => json(200, makeView()));
    const requirement = pick(test);
    await open(requirement);
    const detail = screen.getByRole('region', { name: 'Requirement detail' });
    expect(within(detail).getByText(label, { exact: true })).toBeInTheDocument();
    expect(within(detail).getByText(requirement.text)).toBeInTheDocument();
    expect(within(detail).getByText(`NIST ${requirement.nistId}`)).toBeInTheDocument();
    expect(
      within(detail).getByText(requirement.type === 'basic' ? 'Basic' : 'Derived'),
    ).toBeInTheDocument();
    for (const objective of requirement.objectives) {
      expect(within(detail).getByText(objective.id)).toBeInTheDocument();
      expect(within(detail).getByText(objective.text)).toBeInTheDocument();
    }
  });

  it('shows the partial-credit label and the level Select for 3.5.3 and 3.13.11', async () => {
    fakeApi(() => json(200, makeView()));
    const partial = catalog.requirements.filter((r) => points(r)?.partialCredit);
    expect(partial.map((r) => r.nistId).sort()).toEqual(['3.13.11', '3.5.3']);
    const mfa = partial.find((r) => r.nistId === '3.5.3') as Requirement;
    await open(mfa);
    const label = points(mfa)?.partialCredit?.label ?? '';
    const detail = screen.getByRole('region', { name: 'Requirement detail' });
    expect(within(detail).getByText(label, { selector: 'span' })).toBeInTheDocument();
    const level = within(detail).getByRole('combobox', { name: 'Implementation level' });
    expect(
      within(level)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Not set (worst case)', 'Not implemented', label]);
  });

  it('has no level Select elsewhere, and a single-statement requirement shows its [a] objective', async () => {
    fakeApi(() => json(200, makeView()));
    const single = pick(
      (r) => r.objectives.length === 1 && r.objectives[0]?.id.endsWith('[a]') === true,
    );
    await open(single);
    const detail = screen.getByRole('region', { name: 'Requirement detail' });
    expect(within(detail).queryByRole('combobox', { name: 'Implementation level' })).toBeNull();
    expect(within(detail).getByText(`${single.nistId}[a]`)).toBeInTheDocument();
    expect(within(detail).getByRole('combobox', { name: 'Owner' })).toBeInTheDocument();
  });
});
