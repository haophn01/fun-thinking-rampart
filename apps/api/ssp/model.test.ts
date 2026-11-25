import { loadCatalog, type Requirement } from '@rampart/catalog';
import { evaluateAssessment, type ObjectiveStatus } from '@rampart/rules';
import { REGULATION, closeoutClock } from '@rampart/rules/poam';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_PROFILE_FIELDS,
  type AssessmentView,
  type EvidenceItem,
  type Policy,
  type PoamItem,
  type RequirementState,
  type SystemProfile,
} from '../src/contract';
import { buildSspModel, type SspBlock, type SspModel } from './model';

const catalog = loadCatalog();
const AT = '2026-11-23T09:00:00.000Z';
const TODAY = '2026-11-23';
const ADA = { id: 'u-ada', displayName: 'Ada Admin' };

function requirement(id: string): Requirement {
  const found = catalog.requirements.find((r) => r.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

/** Every objective of these requirements (or of all of them) at one status. */
function results(
  status: ObjectiveStatus,
  ids?: readonly string[],
): Record<string, ObjectiveStatus> {
  const out: Record<string, ObjectiveStatus> = {};
  for (const r of catalog.requirements) {
    if (ids && !ids.includes(r.id)) continue;
    for (const o of r.objectives) out[o.id] = status;
  }
  return out;
}

const EMPTY_PROFILE: SystemProfile = {
  ...(Object.fromEntries(SYSTEM_PROFILE_FIELDS.map(({ key }) => [key, null])) as Record<
    (typeof SYSTEM_PROFILE_FIELDS)[number]['key'],
    null
  >),
  updatedAt: null,
  updatedBy: null,
};

function state(requirementId: string, fields: Partial<RequirementState>): RequirementState {
  return {
    requirementId,
    implementationLevel: null,
    implementationStatement: null,
    owner: null,
    updatedAt: AT,
    ...fields,
  };
}

function poamItem(requirementId: string, fields: Partial<PoamItem> = {}): PoamItem {
  return {
    id: `item-${requirementId}`,
    requirementId,
    status: 'open',
    plan: 'Fix it.',
    due: '2027-01-15',
    milestones: [],
    owner: null,
    createdAt: AT,
    createdBy: ADA,
    updatedAt: AT,
    closeout: null,
    requirementStatus: 'not_met',
    eligibility: { eligible: true },
    daysToDue: 53,
    overdue: false,
    dueAfterDeadline: false,
    readyToClose: false,
    ...fields,
  };
}

function policy(title: string, requirementIds: string[]): Policy {
  return {
    id: `policy-${title}`,
    title,
    description: null,
    requirementIds,
    versions: [],
    createdAt: AT,
    createdBy: ADA,
    updatedAt: AT,
  };
}

function evidence(title: string, objectiveIds: string[]): EvidenceItem {
  return {
    id: `evidence-${title}`,
    title,
    description: null,
    containsCui: false,
    objectiveIds,
    versions: [],
    createdAt: AT,
    createdBy: ADA,
    updatedAt: AT,
  };
}

interface World {
  statuses?: Record<string, ObjectiveStatus>;
  states?: RequirementState[];
  items?: PoamItem[];
  policies?: Policy[];
  evidence?: EvidenceItem[];
  profile?: Partial<SystemProfile>;
  conditionalStatusDate?: string | null;
}

/** The model of a world built the way the api builds its views, with the real rules. */
function modelOf(world: World = {}): SspModel {
  const statuses = world.statuses ?? {};
  const items = world.items ?? [];
  const objectiveResults = Object.entries(statuses).map(([objectiveId, status]) => ({
    objectiveId,
    status,
  }));
  const openPoamRequirementIds = catalog.requirements
    .map((r) => r.id)
    .filter((id) => items.some((i) => i.requirementId === id && i.status === 'open'));
  const date = world.conditionalStatusDate ?? null;
  const closeout = date === null ? null : closeoutClock(date, TODAY, REGULATION);
  const view: AssessmentView = {
    assessment: {
      id: 'assessment-1',
      type: 'self',
      conditionalStatusDate: date,
      catalogVersion: 'nist-800-171-r2@1.0.0',
      updatedAt: AT,
    },
    objectiveResults: objectiveResults.map((r) => ({
      ...r,
      note: null,
      updatedAt: AT,
      updatedBy: ADA,
    })),
    requirementStates: world.states ?? [],
    openPoamRequirementIds,
    evaluation: evaluateAssessment(
      catalog,
      {
        objectiveResults,
        implementationLevels: Object.fromEntries(
          (world.states ?? []).flatMap((s) =>
            s.implementationLevel === null ? [] : [[s.requirementId, s.implementationLevel]],
          ),
        ),
        openPoamRequirementIds,
      },
      REGULATION,
    ),
    closeout,
  };
  return buildSspModel({
    catalog,
    profile: { ...EMPTY_PROFILE, ...world.profile },
    view,
    poam: { items, candidates: [], closeout, confirmer: 'organization' },
    policies: world.policies ?? [],
    evidence: world.evidence ?? [],
  });
}

const headings = (model: SspModel, level: 1 | 2 | 3) =>
  model.blocks.flatMap((b) => (b.kind === 'heading' && b.level === level ? [b.text] : []));

/** The blocks after the heading with this text, up to the next heading of that level or higher. */
function sectionOf(model: SspModel, text: string): SspBlock[] {
  const start = model.blocks.findIndex((b) => b.kind === 'heading' && b.text === text);
  expect(start, `a heading "${text}"`).not.toBe(-1);
  const head = model.blocks[start];
  if (head?.kind !== 'heading') return [];
  const rest = model.blocks.slice(start + 1);
  const end = rest.findIndex((b) => b.kind === 'heading' && b.level <= head.level);
  return end === -1 ? rest : rest.slice(0, end);
}

function fieldOf(blocks: SspBlock[], label: string): string | undefined {
  for (const b of blocks) if (b.kind === 'field' && b.label === label) return b.value;
  return undefined;
}

function textOf(blocks: SspBlock[], label: string): string | undefined {
  for (const b of blocks) if (b.kind === 'text' && b.label === label) return b.text;
  return undefined;
}

function listOf(blocks: SspBlock[], label: string): string[] | string | undefined {
  for (const b of blocks) {
    if (b.kind === 'list' && b.label === label) return b.items.length > 0 ? b.items : b.empty;
  }
  return undefined;
}

function tableOf(blocks: SspBlock[]): { columns: string[]; rows: string[][] } {
  for (const b of blocks) if (b.kind === 'table') return { columns: b.columns, rows: b.rows };
  expect.unreachable('no table');
}

const SECTIONS = [
  '1. System characteristics',
  '2. Assessment summary',
  '3. Security requirements',
  '4. Plan of action and milestones',
];

describe('buildSspModel', () => {
  it('document order and completeness', () => {
    const saved: Partial<Record<string, string>> = {
      systemName: 'Enclave One',
      cageCode: '1ABC2',
      description: 'Line one\nLine two',
    };
    const model = modelOf({ profile: saved });

    // 1. The title block.
    expect(model.blocks.slice(0, 6)).toEqual([
      { kind: 'title', text: 'System Security Plan' },
      { kind: 'subtitle', text: 'Enclave One' },
      { kind: 'generated' },
      { kind: 'field', label: 'Catalog version', value: 'nist-800-171-r2@1.0.0' },
      {
        kind: 'field',
        label: 'Regulation version',
        value: `cmmc-32-cfr-170@${REGULATION.version}`,
      },
      { kind: 'field', label: 'Assessment type', value: 'Self-assessment' },
    ]);
    expect(model.blocks[6]).toEqual({ kind: 'heading', level: 1, text: SECTIONS[0] });
    expect(headings(model, 1)).toEqual(SECTIONS);

    // 2. One row per profile field, in order, with its value or "Not provided".
    const characteristics = tableOf(sectionOf(model, SECTIONS[0] ?? ''));
    expect(characteristics.columns).toEqual(['Characteristic', 'Value']);
    expect(characteristics.rows).toEqual(
      SYSTEM_PROFILE_FIELDS.map(({ key, label }) => [label, saved[key] ?? 'Not provided']),
    );

    // 3. Every family in order, and every requirement in catalog order under its own family.
    expect(headings(model, 2)).toEqual(
      catalog.families.map((f) => `${f.nistSection} ${f.name} (${f.code})`),
    );
    expect(headings(model, 2)[0]).toBe('3.1 Access Control (AC)');
    expect(headings(model, 3)).toEqual(catalog.requirements.map((r) => r.id));
    expect(headings(model, 3)).toHaveLength(110);
    for (const family of catalog.families) {
      const under = sectionOf(model, `${family.nistSection} ${family.name} (${family.code})`);
      expect(under.flatMap((b) => (b.kind === 'heading' && b.level === 3 ? [b.text] : []))).toEqual(
        family.requirementIds,
      );
    }
    // Each requirement starts with its text.
    expect(sectionOf(model, 'AC.L2-3.1.1')[0]).toEqual({
      kind: 'paragraph',
      text: requirement('AC.L2-3.1.1').text,
    });

    // With no name, the subtitle says so.
    expect(modelOf().blocks[1]).toEqual({ kind: 'subtitle', text: 'System not named' });
  });

  it('requirement lines', () => {
    const lab = 'IA.L2-3.5.3';
    const fips = 'SC.L2-3.13.11';
    const model = modelOf({
      statuses: {
        ...results('met', ['AC.L2-3.1.1']),
        ...results('na', ['AC.L2-3.1.2']),
        ...results('not_met', ['AC.L2-3.1.3', lab]),
        '3.1.4[a]': 'met',
      },
      states: [
        state('AC.L2-3.1.1', {
          implementationStatement: 'We use SSO.\nEvery account is reviewed.',
          owner: { id: 'u-ada', displayName: 'Ada Admin', active: true },
        }),
        state('AC.L2-3.1.3', { owner: { id: 'u-gh', displayName: 'Grace Hopper', active: false } }),
        state(lab, { implementationLevel: 'partial' }),
        state(fips, { implementationLevel: 'none' }),
      ],
    });

    const ac1 = sectionOf(model, 'AC.L2-3.1.1');
    expect(fieldOf(ac1, 'Status')).toBe('Met');
    expect(fieldOf(sectionOf(model, 'AC.L2-3.1.2'), 'Status')).toBe('Not Applicable');
    expect(fieldOf(sectionOf(model, 'AC.L2-3.1.3'), 'Status')).toBe('Not Met');
    // One objective Met and the rest missing is still Not Assessed.
    expect(fieldOf(sectionOf(model, 'AC.L2-3.1.4'), 'Status')).toBe('Not Assessed');

    // Points from the catalog, or Prerequisite for the SSP requirement.
    for (const r of catalog.requirements) {
      expect(fieldOf(sectionOf(model, r.id), 'Points')).toBe(
        r.scoring.kind === 'points' ? String(r.scoring.points) : 'Prerequisite',
      );
    }
    expect(fieldOf(sectionOf(model, 'CA.L2-3.12.4'), 'Points')).toBe('Prerequisite');

    // The implementation level only on the two partial-credit requirements.
    const withLevel = catalog.requirements
      .filter((r) => fieldOf(sectionOf(model, r.id), 'Implementation level') !== undefined)
      .map((r) => r.id);
    expect(withLevel).toEqual([lab, fips]);
    const labCredit = requirement(lab).scoring;
    expect(fieldOf(sectionOf(model, lab), 'Implementation level')).toBe(
      labCredit.kind === 'points' ? labCredit.partialCredit?.label : undefined,
    );
    expect(fieldOf(sectionOf(model, fips), 'Implementation level')).toBe('Not implemented');
    const unset = modelOf();
    expect(fieldOf(sectionOf(unset, fips), 'Implementation level')).toBe('Not set (worst case)');

    // The owner, marked when inactive, or Unassigned.
    expect(fieldOf(ac1, 'Owner')).toBe('Ada Admin');
    expect(fieldOf(sectionOf(model, 'AC.L2-3.1.3'), 'Owner')).toBe('Grace Hopper (inactive)');
    expect(fieldOf(sectionOf(model, 'AC.L2-3.1.2'), 'Owner')).toBe('Unassigned');

    // The statement, or the empty line.
    expect(textOf(ac1, 'Implementation statement')).toBe('We use SSO.\nEvery account is reviewed.');
    expect(textOf(sectionOf(model, 'AC.L2-3.1.2'), 'Implementation statement')).toBe(
      'No implementation statement recorded.',
    );

    // The objectives table: every catalog objective, missing results as Not Assessed.
    const objectives = tableOf(sectionOf(model, 'AC.L2-3.1.4'));
    expect(objectives.columns).toEqual(['ID', 'Objective', 'Status']);
    expect(objectives.rows).toEqual(
      requirement('AC.L2-3.1.4').objectives.map((o) => [
        o.id,
        o.text,
        o.id === '3.1.4[a]' ? 'Met' : 'Not Assessed',
      ]),
    );
    expect(tableOf(sectionOf(model, 'AC.L2-3.1.2')).rows.map((row) => row[2])).toEqual(
      requirement('AC.L2-3.1.2').objectives.map(() => 'N/A'),
    );
    expect(tableOf(sectionOf(model, 'AC.L2-3.1.3')).rows.map((row) => row[2])).toEqual(
      requirement('AC.L2-3.1.3').objectives.map(() => 'Not Met'),
    );
  });

  it('summary edges', () => {
    // Nothing assessed: Not Assessed everywhere and no score.
    const empty = modelOf();
    const emptySummary = sectionOf(empty, SECTIONS[1] ?? '');
    expect(emptySummary[0]).toEqual({
      kind: 'paragraph',
      text: 'SPRS incomplete: CA.L2-3.12.4 must be Met',
    });
    expect(fieldOf(emptySummary, 'Conditional status')).toBe('Assessment incomplete');
    expect(fieldOf(emptySummary, 'Conditional Status Date')).toBeUndefined();
    expect(fieldOf(emptySummary, 'Closeout deadline')).toBeUndefined();
    expect(tableOf(emptySummary)).toEqual({
      columns: ['Requirement status', 'Requirements'],
      rows: [
        ['Met', '0'],
        ['Not Met', '0'],
        ['Not Applicable', '0'],
        ['Not Assessed', '110'],
      ],
    });
    expect(fieldOf(emptySummary, 'Open POA&M items')).toBe('0');
    for (const r of catalog.requirements) {
      expect(fieldOf(sectionOf(empty, r.id), 'Status')).toBe('Not Assessed');
    }

    // All Met: the full score and Final.
    const all = sectionOf(modelOf({ statuses: results('met') }), SECTIONS[1] ?? '');
    expect(all[0]).toEqual({ kind: 'paragraph', text: 'SPRS 110 / 110' });
    expect(fieldOf(all, 'Conditional status')).toBe('Final status reachable');

    // One eligible 1-point requirement Not Met with an open item, one requirement all N/A and a
    // Conditional Status Date: the score, Conditional, the dates and the counts.
    const onePoint = catalog.requirements.find(
      (r) =>
        r.scoring.kind === 'points' &&
        r.scoring.points === 1 &&
        !REGULATION.poamBarred.value.includes(r.id),
    );
    if (!onePoint) throw new Error('no 1-point requirement');
    const scored = modelOf({
      statuses: {
        ...results('met'),
        ...results('not_met', [onePoint.id]),
        ...results('na', ['AC.L2-3.1.2']),
      },
      items: [
        poamItem(onePoint.id),
        poamItem('AC.L2-3.1.1', { id: 'closed-1', status: 'closed', requirementStatus: 'met' }),
      ],
      conditionalStatusDate: '2026-11-01',
    });
    const summary = sectionOf(scored, SECTIONS[1] ?? '');
    expect(summary[0]).toEqual({ kind: 'paragraph', text: 'SPRS 109 / 110' });
    expect(fieldOf(summary, 'Conditional status')).toBe('Conditional status reachable');
    expect(fieldOf(summary, 'Conditional Status Date')).toBe('2026-11-01');
    expect(fieldOf(summary, 'Closeout deadline')).toBe(
      closeoutClock('2026-11-01', TODAY, REGULATION).deadline,
    );
    expect(tableOf(summary).rows).toEqual([
      ['Met', '108'],
      ['Not Met', '1'],
      ['Not Applicable', '1'],
      ['Not Assessed', '0'],
    ]);
    // Only open items count.
    expect(fieldOf(summary, 'Open POA&M items')).toBe('1');
  });

  it('links and POA&M', () => {
    const model = modelOf({
      statuses: results('not_met', ['AC.L2-3.1.1', 'AC.L2-3.1.2']),
      policies: [
        policy('Access Policy', ['AC.L2-3.1.1', 'AC.L2-3.1.3']),
        policy('Remote Work', ['AC.L2-3.1.1']),
      ],
      evidence: [
        // Linked through two objectives of 3.1.1: listed once.
        evidence('Account review', ['3.1.1[a]', '3.1.1[b]']),
        evidence('SSO config', ['3.1.1[c]', '3.1.3[a]']),
        evidence('Unrelated', ['3.2.1[a]']),
      ],
      items: [
        poamItem('AC.L2-3.1.1', {
          plan: 'Turn on MFA.\nThen review.',
          due: '2027-02-01',
          milestones: [
            { title: 'Pilot', due: '2027-01-01', doneOn: '2026-11-20' },
            { title: 'Roll out', due: '2027-01-20', doneOn: null },
          ],
          owner: { id: 'u-ada', displayName: 'Ada Admin', active: true },
        }),
        poamItem('AC.L2-3.1.2', {
          id: 'closed-2',
          status: 'closed',
          plan: 'Old plan.',
          due: '2026-10-01',
          owner: { id: 'u-gh', displayName: 'Grace Hopper', active: false },
          closeout: {
            closedOn: '2026-11-10',
            note: null,
            confirmedBy: 'organization',
            c3paoName: null,
            recordedBy: ADA,
            late: false,
          },
        }),
      ],
    });

    const ac1 = sectionOf(model, 'AC.L2-3.1.1');
    expect(listOf(ac1, 'Policies')).toEqual(['Access Policy', 'Remote Work']);
    expect(listOf(ac1, 'Evidence')).toEqual(['Account review', 'SSO config']);
    const ac3 = sectionOf(model, 'AC.L2-3.1.3');
    expect(listOf(ac3, 'Policies')).toEqual(['Access Policy']);
    expect(listOf(ac3, 'Evidence')).toEqual(['SSO config']);
    const ac2 = sectionOf(model, 'AC.L2-3.1.2');
    expect(listOf(ac2, 'Policies')).toBe('None linked');
    expect(listOf(ac2, 'Evidence')).toBe('None linked');

    // Only the open item shows under its requirement.
    expect(fieldOf(ac1, 'Open POA&M item')).toBe('Due 2027-02-01');
    expect(textOf(ac1, 'Plan')).toBe('Turn on MFA.\nThen review.');
    expect(fieldOf(ac2, 'Open POA&M item')).toBeUndefined();
    expect(textOf(ac2, 'Plan')).toBeUndefined();
    expect(fieldOf(ac3, 'Open POA&M item')).toBeUndefined();

    // Every item is in section 4, in the POA&M view's order.
    const poam = tableOf(sectionOf(model, SECTIONS[3] ?? ''));
    expect(poam.columns).toEqual([
      'Requirement',
      'Status',
      'Due',
      'Plan',
      'Milestones',
      'Owner',
      'Closed on',
    ]);
    expect(poam.rows).toEqual([
      [
        'AC.L2-3.1.1',
        'Open',
        '2027-02-01',
        'Turn on MFA.\nThen review.',
        '2',
        'Ada Admin',
        'Not closed',
      ],
      [
        'AC.L2-3.1.2',
        'Closed',
        '2026-10-01',
        'Old plan.',
        '0',
        'Grace Hopper (inactive)',
        '2026-11-10',
      ],
    ]);

    // With no items, section 4 says so instead of an empty table.
    expect(sectionOf(modelOf(), SECTIONS[3] ?? '')).toEqual([
      { kind: 'paragraph', text: 'No POA&M items recorded.' },
    ]);
  });
});
