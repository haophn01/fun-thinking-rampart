import {
  SSP_LARGE_IMAGE_BYTES,
  SSP_MAX_EMBEDDED_IMAGES,
  type Asset,
  type DiagramLink,
  type DocumentControl,
} from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import { SSP_LINT_RULES, lintSspFrom, type SspLintFinding } from '@rampart/rules';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, renderSsp, stubApi, type Routes } from '../kit/testing';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const AT = '2026-11-24T10:00:00.000Z';
const catalog = loadCatalog();
const IDS = catalog.requirements.map((r) => r.id);
const LIMITS = {
  maxEmbeddedImages: SSP_MAX_EMBEDDED_IMAGES,
  largeImageBytes: SSP_LARGE_IMAGE_BYTES,
};

interface World {
  /** Statement overrides by requirement id; every other requirement has a clean statement. */
  statements?: Record<string, string | null>;
  assets?: Asset[];
  diagrams?: DiagramLink[];
  review?: Partial<DocumentControl>;
}

function asset(over: Partial<Asset> & Pick<Asset, 'id' | 'name' | 'category'>): Asset {
  return {
    assetType: null,
    owner: null,
    location: null,
    treatment: null,
    outOfScopeJustification: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function diagram(id: string): DiagramLink {
  return {
    id,
    kind: 'network',
    caption: `Diagram ${id}`,
    evidence: { id: `e-${id}`, title: `Evidence ${id}`, containsCui: false },
    version: null,
    resolved: {
      version: 1,
      kind: 'file',
      fileName: `${id}.png`,
      size: 1000,
      sha256: null,
      location: null,
      createdAt: AT,
    },
    embeddable: true,
    createdAt: AT,
    updatedAt: AT,
  };
}

function bodies(world: World = {}) {
  const view = {
    assessment: {
      id: 'a-1',
      type: 'self',
      conditionalStatusDate: null,
      catalogVersion: 'v1',
      updatedAt: AT,
    },
    objectiveResults: [],
    requirementStates: IDS.map((requirementId) => ({
      requirementId,
      implementationLevel: null,
      implementationStatement:
        world.statements !== undefined && requirementId in world.statements
          ? world.statements[requirementId]
          : 'The control is in place.',
      owner: null,
      plannedImplementation: null,
      naRationale: null,
      updatedAt: AT,
    })),
    openPoamRequirementIds: [],
    evaluation: {
      outcomes: IDS.map((requirementId) => ({
        requirementId,
        status: 'met',
        allNa: false,
        counts: { met: 0, not_met: 0, na: 0, not_assessed: 0 },
        implementationLevel: null,
        deduction: 0,
      })),
      score: {
        kind: 'incomplete',
        reason: 'prerequisite_not_met',
        prerequisites: [],
        max: 110,
        floor: -203,
        notAssessed: [],
      },
      conditional: { status: 'incomplete', blockers: [] },
    },
    closeout: null,
  };
  const assets = world.assets ?? [asset({ id: 'a-1', name: 'Laptops', category: 'cui' })];
  const diagrams = world.diagrams ?? [diagram('d-1')];
  const control: DocumentControl = {
    reviewCadenceMonths: 12,
    nextReviewDate: '2027-01-01',
    nextReviewDue: '2027-01-01',
    daysToReview: 37,
    reviewOverdue: false,
    revisions: [],
    approvals: [],
    ...world.review,
  };
  return { view, assets, diagrams, control };
}

/** What the api would lint: the same function over the same bodies. */
function expected(world: World = {}): SspLintFinding[] {
  const { view, assets, diagrams, control } = bodies(world);
  // The mocked body is a plain object; the lint only reads its structural fields.
  const sources = { view, assets, diagrams, review: control } as unknown as Parameters<
    typeof lintSspFrom
  >[1];
  return lintSspFrom(catalog, sources, LIMITS);
}

const READS = [
  'GET /api/assessment',
  'GET /api/ssp/assets',
  'GET /api/ssp/diagrams',
  'GET /api/ssp/document-control',
] as const;

function routes(world: World = {}): Routes {
  const b = bodies(world);
  return {
    'GET /api/assessment': () => json(200, b.view),
    'GET /api/ssp/assets': () => json(200, { assets: b.assets }),
    'GET /api/ssp/diagrams': () => json(200, { diagrams: b.diagrams }),
    'GET /api/ssp/document-control': () => json(200, b.control),
  };
}

function open(world: World = {}, extra: Routes = {}) {
  const api = stubApi({ ...routes(world), ...extra });
  renderSsp('export');
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const lintSection = async () => {
  const panel = await screen.findByRole('tabpanel', { name: 'Lint & export' });
  return within(panel).getByRole('region', { name: /Pre-export check/ });
};

/** The group alerts of the panel, in page order. */
function groups(section: HTMLElement): HTMLElement[] {
  return Array.from(section.querySelectorAll<HTMLElement>('[data-tone]')).filter(
    (el) => el.querySelector('li') !== null,
  );
}

const label = (id: string) => SSP_LINT_RULES.find((r) => r.id === id)?.label ?? '';
const messagesOf = (group: HTMLElement) =>
  within(group)
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-message]')?.textContent);

/** A world that trips error groups and a warning group. */
const MIXED: World = {
  assets: [
    asset({ id: 'a-9', name: 'Kiosk', category: 'out_of_scope', outOfScopeJustification: null }),
  ],
  diagrams: [],
  statements: { [IDS[3] ?? '']: 'We will add MFA.' },
};

describe('Lint panel', () => {
  it('findings match the rules', async () => {
    open(MIXED);
    const section = await lintSection();
    const want = expected(MIXED);
    expect(want.length).toBeGreaterThan(2);
    const errors = want.filter((f) => f.severity === 'error').length;
    const warnings = want.filter((f) => f.severity === 'warning').length;
    await within(section).findByText(
      `${String(errors)} ${errors === 1 ? 'error' : 'errors'} · ${String(warnings)} ${warnings === 1 ? 'warning' : 'warnings'}`,
    );

    const ruleOrder = SSP_LINT_RULES.map((r) => r.id).filter((id) =>
      want.some((f) => f.rule === id),
    );
    const shown = groups(section);
    expect(shown.map((g) => g.querySelector('p')?.textContent)).toEqual(
      ruleOrder.map((id) => `${label(id)} · ${String(want.filter((f) => f.rule === id).length)}`),
    );
    shown.forEach((group, index) => {
      const messages = want.filter((f) => f.rule === ruleOrder[index]).map((f) => f.message);
      expect(messagesOf(group)).toEqual(messages.slice(0, 10));
    });
  });

  it('severity tones', async () => {
    open(MIXED);
    const section = await lintSection();
    await within(section).findByText(`${label('future_tense')} · 1`);
    const want = expected(MIXED);
    expect(want.some((f) => f.severity === 'error')).toBe(true);
    expect(want.some((f) => f.severity === 'warning')).toBe(true);
    for (const rule of SSP_LINT_RULES.filter((r) => want.some((f) => f.rule === r.id))) {
      const count = want.filter((f) => f.rule === rule.id).length;
      const group = within(section)
        .getByText(`${rule.label} · ${String(count)}`)
        .closest('[data-tone]') as HTMLElement;
      expect(group, rule.id).toHaveAttribute(
        'data-tone',
        rule.severity === 'error' ? 'error' : 'info',
      );
      expect(group).toHaveAttribute('role', rule.severity === 'error' ? 'alert' : 'status');
      expect(within(group).getByText(rule.hint)).toBeInTheDocument();
    }
  });

  it('links', async () => {
    const world: World = {
      ...MIXED,
      review: { reviewOverdue: true, nextReviewDue: '2026-11-01', daysToReview: -24 },
    };
    open(world);
    const section = await lintSection();
    const want = expected(world);
    const req = want.find((f) => f.rule === 'future_tense');
    const reqId = req?.requirementId ?? '';
    const family = catalog.requirements.find((r) => r.id === reqId)?.family ?? '';
    const item = (await within(section).findByText(req?.message ?? '')).closest(
      'li',
    ) as HTMLElement;
    expect(within(item).getByRole('link', { name: new RegExp(reqId) })).toHaveAttribute(
      'href',
      `/assessment?family=${family}&req=${reqId}`,
    );
    const tabLink = (rule: string) =>
      within(
        within(section)
          .getByText(`${label(rule)} · 1`)
          .closest('[data-tone]') as HTMLElement,
      ).getByRole('link', { name: /Open (Assets|Environment|Document control)/ });
    expect(tabLink('out_of_scope_unjustified')).toHaveAttribute('href', '/ssp?tab=assets');
    expect(tabLink('no_network_diagram')).toHaveAttribute('href', '/ssp?tab=environment');
    expect(tabLink('review_overdue')).toHaveAttribute('href', '/ssp?tab=document-control');
  });

  it('long groups', async () => {
    const user = userEvent.setup();
    const world: World = {
      statements: Object.fromEntries(IDS.slice(0, 12).map((id) => [id, ''])),
    };
    open(world);
    const section = await lintSection();
    const group = (await within(section).findByText(`${label('empty_statement')} · 12`)).closest(
      '[data-tone]',
    ) as HTMLElement;
    expect(within(group).getAllByRole('listitem')).toHaveLength(10);
    await user.click(within(group).getByRole('button', { name: 'Show all 12' }));
    expect(messagesOf(group)).toEqual(
      expected(world)
        .filter((f) => f.rule === 'empty_statement')
        .map((f) => f.message),
    );
    expect(within(group).queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  it('summary', async () => {
    open();
    const section = await lintSection();
    expect(
      await within(section).findByText('No findings. Every check passes.'),
    ).toBeInTheDocument();
    expect(groups(section)).toHaveLength(0);
  });

  it('summary pluralizes', async () => {
    open({
      statements: { [IDS[0] ?? '']: 'We will do it.', [IDS[1] ?? '']: 'TBD' },
      diagrams: [],
    });
    const section = await lintSection();
    expect(await within(section).findByText('1 error · 2 warnings')).toBeInTheDocument();
  });

  it('check again', async () => {
    const user = userEvent.setup();
    let world: World = { diagrams: [] };
    const api = open(world, {
      'GET /api/ssp/diagrams': () => json(200, { diagrams: bodies(world).diagrams }),
    });
    const section = await lintSection();
    await within(section).findByText('1 error · 0 warnings');
    world = {};
    await user.click(within(section).getByRole('button', { name: 'Check again' }));
    expect(
      await within(section).findByText('No findings. Every check passes.'),
    ).toBeInTheDocument();
    for (const key of READS) expect(api.sent(key), key).toHaveLength(2);
  });

  it('load failure', async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = open(
      {},
      {
        'GET /api/ssp/assets': () =>
          fail ? apiError(500, 'internal') : json(200, { assets: bodies().assets }),
      },
    );
    const panel = await screen.findByRole('tabpanel', { name: 'Lint & export' });
    const section = within(panel).getByRole('region', { name: /Pre-export check/ });
    const title = await within(section).findByText("Can't run the pre-export check");
    // Readiness and the export link are unaffected.
    const readiness = within(panel).getByRole('region', { name: /Readiness/ });
    expect(await within(readiness).findByText('Met')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Export SSP (.docx)' })).toBeInTheDocument();
    fail = false;
    await user.click(
      within(title.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }),
    );
    expect(
      await within(section).findByText('No findings. Every check passes.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(api.sent('GET /api/ssp/assets')).toHaveLength(2);
    });
  });
});
