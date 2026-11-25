import { loadCatalog } from '@rampart/catalog';
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

const catalog = loadCatalog();

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture missing');
  return value;
}

const AT = '2026-11-24T10:00:00.000Z';
const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const R_3120 = must(catalog.requirements.find((r) => r.id.endsWith('3.1.20')));
const R_3112 = 'CA.L2-3.12.4';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

type Blocker = Record<string, unknown>;
interface Parts {
  kind?: 'scored' | 'incomplete';
  score?: number;
  status?: 'final' | 'conditional' | 'not_eligible' | 'incomplete';
  blockers?: Blocker[];
  outcomes?: unknown[];
  results?: unknown[];
  closeout?: unknown;
  assessmentId?: string;
}

function assessment(p: Parts = {}) {
  const kind = p.kind ?? 'scored';
  return {
    assessment: {
      id: p.assessmentId ?? 'abcdef12-3456-7890-abcd-ef1234567890',
      type: 'self',
      conditionalStatusDate: null,
      catalogVersion: 'nist-800-171-r2@1.0.0',
      updatedAt: AT,
    },
    objectiveResults: p.results ?? [],
    requirementStates: [],
    openPoamRequirementIds: [],
    evaluation: {
      outcomes: p.outcomes ?? [],
      score:
        kind === 'scored'
          ? {
              kind: 'scored',
              score: p.score ?? 72,
              max: 110,
              floor: -203,
              deductions: [],
              notAssessed: [],
            }
          : {
              kind: 'incomplete',
              reason: 'prerequisite_not_met',
              prerequisites: [R_3112],
              max: 110,
              floor: -203,
              notAssessed: [],
            },
      conditional: { status: p.status ?? 'not_eligible', blockers: p.blockers ?? [] },
    },
    closeout: p.closeout ?? null,
  };
}

function poam(items: unknown[] = [], closeout: unknown = null) {
  return { items, candidates: [], closeout, confirmer: 'organization' };
}

function profile(systemName: string | null) {
  return {
    profile: {
      systemName,
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
    },
  };
}

interface Api {
  assessment?: () => Response | Promise<Response>;
  poam?: unknown;
  profile?: unknown;
}

function fakeApi(api: Api) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      calls.push(input);
      if (input === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }));
      if (input === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      if (input === '/api/assessment')
        return Promise.resolve(api.assessment ? api.assessment() : json(200, assessment()));
      if (input === '/api/poam') return Promise.resolve(json(200, api.poam ?? poam()));
      if (input === '/api/system-profile')
        return Promise.resolve(json(200, api.profile ?? profile(null)));
      return Promise.resolve(json(404, { error: { code: 'not_found', message: 'nf' } }));
    }),
  );
  return calls;
}

function mount() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AuthedApp />
    </MemoryRouter>,
  );
}

async function ready() {
  mount();
  return await screen.findByTestId('score-value');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('hold at 72', () => {
  it('shows 72, OUT OF TOL, HOLD and the 3.1.20 blocker text', async () => {
    fakeApi({
      assessment: () =>
        json(
          200,
          assessment({
            score: 72,
            blockers: [
              { code: 'below_threshold', score: 72, threshold: 88, citation: '32 CFR 170.21' },
              {
                code: 'poam_ineligible',
                requirementId: R_3120.id,
                reasons: ['barred'],
                citation: '32 CFR 170.21(a)(2)(iii)',
              },
            ],
          }),
        ),
    });
    const value = await ready();
    expect(value).toHaveTextContent('72');
    expect(screen.getByText('/ 110')).toBeInTheDocument();
    expect(screen.getByText('OUT OF TOL')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: "Inspector's stamp: HOLD" })).toHaveTextContent(
      '2 BLOCKERS',
    );
    expect(screen.getByText('Conditional status needs 88. You are 16 points short.')).toBeVisible();
    const check = screen.getByRole('region', { name: 'Conditional check' });
    expect(check).toHaveTextContent(`${R_3120.id} cannot go on a POA&M`);
    expect(check).toHaveTextContent('32 CFR 170.21(a)(2)(iii)');
    expect(check).toHaveTextContent('POA&M · 0 open');
    expect(check).toHaveTextContent('180-day clock: not started');
    expect(screen.getByRole('link', { name: 'Continue assessment' })).toHaveAttribute(
      'href',
      '/assessment',
    );
  });
});

describe('stamp follows conditional status', () => {
  it('shows ACCEPT and IN TOL when the status is conditional', async () => {
    fakeApi({
      assessment: () =>
        json(
          200,
          assessment({
            score: 95,
            status: 'conditional',
            closeout: {
              conditionalStatusDate: '2026-11-24',
              deadline: '2027-05-23',
              daysRemaining: 180,
              expired: false,
            },
          }),
        ),
    });
    await ready();
    expect(screen.getByRole('img', { name: "Inspector's stamp: ACCEPT" })).toHaveTextContent(
      'CONDITIONAL',
    );
    expect(screen.getByText('IN TOL')).toBeInTheDocument();
    expect(screen.getByText('At or above the Conditional minimum of 88.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Conditional check' })).toHaveTextContent(
      'Closeout due 2027-05-23 · 180 days left',
    );
  });

  it('at 95 with a poam_missing blocker the stamp holds while the frame is IN TOL', async () => {
    fakeApi({
      assessment: () =>
        json(
          200,
          assessment({
            score: 95,
            blockers: [
              { code: 'poam_missing', requirementId: R_3120.id, citation: '32 CFR 170.24' },
            ],
          }),
        ),
    });
    await ready();
    expect(screen.getByRole('img', { name: "Inspector's stamp: HOLD" })).toHaveTextContent(
      '1 BLOCKER',
    );
    expect(screen.getByText('IN TOL')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Conditional check' })).toHaveTextContent(
      `${R_3120.id} is Not Met and has no open POA&M item`,
    );
  });

  it('says the closeout deadline passed when the clock has expired', async () => {
    fakeApi({
      assessment: () =>
        json(
          200,
          assessment({
            score: 95,
            status: 'final',
            closeout: {
              conditionalStatusDate: '2026-01-01',
              deadline: '2026-06-30',
              daysRemaining: -10,
              expired: true,
            },
          }),
        ),
    });
    await ready();
    expect(screen.getByRole('img', { name: "Inspector's stamp: ACCEPT" })).toHaveTextContent(
      'FINAL',
    );
    expect(screen.getByRole('region', { name: 'Conditional check' })).toHaveTextContent(
      'Closeout deadline passed',
    );
  });
});

describe('incomplete', () => {
  it('shows —, NO READING, HOLD and the SSP message', async () => {
    fakeApi({
      assessment: () =>
        json(
          200,
          assessment({
            kind: 'incomplete',
            status: 'incomplete',
            blockers: [
              { code: 'prerequisite_not_met', requirementId: R_3112, citation: '32 CFR 170.21' },
            ],
          }),
        ),
    });
    const value = await ready();
    expect(value).toHaveTextContent('—');
    expect(screen.getByText('NO READING')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: "Inspector's stamp: HOLD" })).toBeInTheDocument();
    expect(
      screen.getAllByText(`${R_3112} System Security Plan must be Met before a score exists`)
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('sections', () => {
  it('counts objectives, lists families and needs-attention rows', async () => {
    const [first, second] = must(catalog.requirements[0]).objectives;
    fakeApi({
      assessment: () =>
        json(
          200,
          assessment({
            results: [
              {
                objectiveId: must(first).id,
                status: 'met',
                note: null,
                updatedAt: AT,
                updatedBy: { id: 'u-1', displayName: 'Ada Admin' },
              },
              {
                objectiveId: must(second).id,
                status: 'na',
                note: null,
                updatedAt: AT,
                updatedBy: { id: 'u-1', displayName: 'Ada Admin' },
              },
            ],
          }),
        ),
    });
    await ready();
    const objectives = screen.getByRole('region', { name: 'Objectives · 320' });
    expect(objectives).toHaveTextContent('Met');
    expect(within(objectives).getByTestId('count-met')).toHaveTextContent('1');
    expect(within(objectives).getByTestId('count-na')).toHaveTextContent('1');
    expect(within(objectives).getByTestId('count-not_assessed')).toHaveTextContent('318');
    const families = screen.getByRole('region', { name: 'Families · 14' });
    expect(within(families).getAllByRole('progressbar')).toHaveLength(14);
    expect(screen.getByRole('region', { name: 'Needs attention' })).toHaveTextContent(
      'Nothing needs attention.',
    );
  });
});

describe('loading and error', () => {
  it('shows the h1 at once, then a failed call shows the error and Retry reloads', async () => {
    let failing = true;
    fakeApi({
      assessment: () =>
        failing
          ? json(500, {
              error: {
                code: 'internal_error',
                message: 'The database is down',
                requestId: 'req-1',
              },
            })
          : json(200, assessment()),
    });
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByTestId('score-value')).not.toBeInTheDocument();
    expect(await screen.findByText('The database is down')).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('score-value')).toHaveTextContent('72');
    expect(screen.queryByText('The database is down')).not.toBeInTheDocument();
  });

  it('a failed POA&M call also shows the error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        if (input === '/api/session')
          return Promise.resolve(
            json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }),
          );
        if (input === '/api/assessment') return Promise.resolve(json(200, assessment()));
        if (input === '/api/system-profile') return Promise.resolve(json(200, profile(null)));
        if (input === '/api/poam')
          return Promise.resolve(
            json(500, {
              error: { code: 'internal_error', message: 'POA&M down', requestId: 'req-2' },
            }),
          );
        return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      }),
    );
    mount();
    expect(await screen.findByText('POA&M down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('inspection strip', () => {
  it('shows the IR number, the system name, 320, the user and today', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-24T23:30:00.000Z') });
    fakeApi({ profile: profile('Enclave Alpha') });
    await ready();
    await waitFor(() => {
      expect(screen.getByText('Enclave Alpha')).toBeInTheDocument();
    });
    const strip = screen.getByText('IR', { selector: 'dt' }).closest('dl');
    if (strip === null) throw new Error('no strip');
    expect(strip).toHaveTextContent('IR-ABCDEF12');
    expect(strip).toHaveTextContent('Enclave Alpha');
    expect(strip).toHaveTextContent('nist-800-171-r2@1.0.0');
    expect(strip).toHaveTextContent('320');
    expect(strip).toHaveTextContent('Ada Admin');
    expect(strip).toHaveTextContent('2026-11-24');
  });

  it('falls back to System not named', async () => {
    fakeApi({ profile: profile(null) });
    await ready();
    expect(await screen.findByText('System not named')).toBeInTheDocument();
  });
});
