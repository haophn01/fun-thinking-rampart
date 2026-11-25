import type { AssessmentView, PoamView } from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import { describe, expect, it } from 'vitest';
import { needsAttention } from './attention';

const catalog = loadCatalog();

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture missing');
  return value;
}

const [R1, R2, R3, R4] = catalog.requirements.filter((r) => r.scoring.kind === 'points');
const id = (r: typeof R1) => must(r).id;

type Blockers = AssessmentView['evaluation']['conditional']['blockers'];

function view(blockers: Blockers): AssessmentView {
  return {
    assessment: {
      id: 'a-1',
      type: 'self',
      conditionalStatusDate: null,
      catalogVersion: 'nist-800-171-r2@1.0.0',
      updatedAt: '2026-11-24T10:00:00.000Z',
    },
    objectiveResults: [],
    requirementStates: [],
    evaluation: {
      outcomes: [{ requirementId: id(R3), status: 'not_met' }],
      score: { kind: 'scored', score: 50, max: 110, floor: -203, deductions: [], notAssessed: [] },
      conditional: { status: 'not_eligible', blockers },
    },
    closeout: null,
  } as unknown as AssessmentView;
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    requirementId: id(R1),
    status: 'open',
    plan: 'Fix',
    due: '2026-12-01',
    milestones: [],
    owner: { id: 'u-2', displayName: 'Olive Owner', active: true },
    requirementStatus: 'not_met',
    eligibility: { eligible: true },
    daysToDue: 7,
    overdue: false,
    dueAfterDeadline: false,
    readyToClose: false,
    closeout: null,
    ...over,
  };
}

function poam(items: unknown[] = []): PoamView {
  return { items, candidates: [], closeout: null, confirmer: 'organization' } as PoamView;
}

describe('order and empty', () => {
  it('says nothing when there is nothing to show', () => {
    expect(needsAttention(view([]), poam(), catalog)).toEqual([]);
  });

  it('lists prerequisite, ineligible, missing, overdue, late, ready, then not assessed', () => {
    const rows = needsAttention(
      view([
        { code: 'poam_missing', requirementId: id(R3), citation: 'c' },
        { code: 'not_assessed', requirementIds: ['a', 'b', 'c'] },
        { code: 'poam_ineligible', requirementId: id(R2), reasons: ['barred'], citation: 'c' },
        { code: 'prerequisite_not_met', requirementId: 'CA.L2-3.12.4', citation: 'c' },
      ]),
      poam([
        item({
          id: 'p-ready',
          requirementId: id(R4),
          readyToClose: true,
          requirementStatus: 'met',
        }),
        item({ id: 'p-late', requirementId: id(R2), dueAfterDeadline: true }),
        item({ id: 'p-over', requirementId: id(R1), overdue: true, daysToDue: -3 }),
      ]),
      catalog,
    );
    expect(rows.map((r) => r.kind)).toEqual([
      'prerequisite',
      'poam_ineligible',
      'poam_missing',
      'overdue',
      'due_after_deadline',
      'ready_to_close',
      'not_assessed',
    ]);
    expect(rows.map((r) => r.href)).toEqual([
      '/assessment',
      '/assessment',
      '/poam',
      '/poam',
      '/poam',
      '/poam',
      '/assessment',
    ]);
    expect(rows[0]).toMatchObject({ requirementId: 'CA.L2-3.12.4' });
    expect(rows[2]).toMatchObject({
      requirementId: id(R3),
      chip: 'not_met',
      text: must(R3).text,
      points:
        must(R3).scoring.kind === 'points' ? (must(R3).scoring as { points: number }).points : null,
    });
    expect(rows[3]).toMatchObject({ owner: 'Olive Owner', requirementId: id(R1) });
    expect(rows[6]?.message).toBe('3 requirements not yet assessed');
  });

  it('uses the singular for one requirement not yet assessed', () => {
    const rows = needsAttention(
      view([{ code: 'not_assessed', requirementIds: ['x'] }]),
      poam(),
      catalog,
    );
    expect(rows.at(-1)?.message).toBe('1 requirement not yet assessed');
  });

  it('keeps blockers in the evaluation order within a kind', () => {
    const rows = needsAttention(
      view([
        { code: 'poam_missing', requirementId: id(R1), citation: 'c' },
        { code: 'poam_missing', requirementId: id(R2), citation: 'c' },
      ]),
      poam(),
      catalog,
    );
    expect(rows.map((r) => r.requirementId)).toEqual([id(R1), id(R2)]);
  });
});

describe('POA&M edges', () => {
  it('a closed item never appears, whatever its flags', () => {
    const closed = item({
      status: 'closed',
      overdue: true,
      dueAfterDeadline: true,
      readyToClose: true,
      closeout: { closedOn: '2026-11-01' },
    });
    expect(needsAttention(view([]), poam([closed]), catalog)).toEqual([]);
  });

  it('an open item with no flag never appears', () => {
    expect(needsAttention(view([]), poam([item()]), catalog)).toEqual([]);
  });

  it('an open item that is overdue and due after the deadline appears under both', () => {
    const rows = needsAttention(
      view([]),
      poam([item({ overdue: true, dueAfterDeadline: true })]),
      catalog,
    );
    expect(rows.map((r) => r.kind)).toEqual(['overdue', 'due_after_deadline']);
  });

  it('an unassigned owner shows no owner', () => {
    const rows = needsAttention(view([]), poam([item({ overdue: true, owner: null })]), catalog);
    expect(rows[0]?.owner).toBeNull();
  });
});
