// Test-only builders for the SSP lint: a clean world that fires nothing, small changes on top of
// it, and one world per rule that fires that rule.
import type { RequirementId } from '@rampart/catalog';
import { fixtureCatalog } from '../testing/fixture-catalog';
import type { ObjectiveStatus, RequirementStatus } from '../types';
import type { SspLintLimits, SspLintRuleId, SspLintSources } from './types';

/** Six requirements: AC 3.1.1, 3.1.5, 3.1.9, 3.1.10, IA 3.5.3 and the prerequisite CA 3.12.4. */
export const catalog = fixtureCatalog();
export const SSP_ID = 'CA.L2-3.12.4';
export const MIB = 1024 * 1024;
export const LIMITS: SspLintLimits = { maxEmbeddedImages: 10, largeImageBytes: 5 * MIB };

type View = SspLintSources['view'];
type Outcome = View['evaluation']['outcomes'][number];
type State = View['requirementStates'][number];
type AssetIn = SspLintSources['assets'][number];
type DiagramIn = SspLintSources['diagrams'][number];

const ZERO: Record<ObjectiveStatus, number> = { met: 0, not_met: 0, na: 0, not_assessed: 0 };

/** An outcome with two objectives. `na` N/A objectives count toward Met; 2 of 2 is all N/A. */
export function outcome(
  requirementId: RequirementId,
  status: RequirementStatus,
  na: 0 | 1 | 2 = 0,
): Outcome {
  const counts = { ...ZERO, na };
  const rest = 2 - na;
  if (status === 'met') counts.met = rest;
  else if (status === 'not_met') counts.not_met = rest;
  else counts.not_assessed = rest;
  return { requirementId, status, allNa: na === 2, counts };
}

export function asset(
  id: string,
  category: string,
  outOfScopeJustification: string | null = null,
  name = `Asset ${id}`,
): AssetIn {
  return { id, name, category, outOfScopeJustification };
}

export function diagram(
  id: string,
  kind: string,
  options: Partial<Omit<DiagramIn, 'id' | 'kind'>> = {},
): DiagramIn {
  return {
    id,
    kind,
    caption: `Diagram ${id}`,
    embeddable: false,
    resolved: { size: 1000 },
    ...options,
  };
}

/** Every requirement Met with a statement, one CUI asset, one network diagram, review not due. */
export function cleanSources(): SspLintSources {
  return {
    view: {
      requirementStates: catalog.requirements.map((r) => ({
        requirementId: r.id,
        implementationStatement: `${r.id} is enforced by the identity provider.`,
        naRationale: null,
      })),
      openPoamRequirementIds: [],
      evaluation: { outcomes: catalog.requirements.map((r) => outcome(r.id, 'met')) },
    },
    assets: [asset('a1', 'cui')],
    diagrams: [diagram('d1', 'network')],
    review: { reviewOverdue: false, nextReviewDue: '2027-01-01', daysToReview: 30 },
  };
}

export interface Changes {
  outcomes?: Outcome[];
  /** `plannedImplementation` rides along, as the api sends it, to prove it is never read. */
  states?: (Partial<State> & { requirementId: RequirementId; plannedImplementation?: string })[];
  openPoamRequirementIds?: RequirementId[] | null;
  assets?: AssetIn[];
  diagrams?: DiagramIn[];
  review?: SspLintSources['review'];
}

/**
 * The clean world with changes: outcomes and states replace the same requirement's entry (a
 * state is merged into it); `openPoamRequirementIds: null` drops the list.
 */
export function sourcesWith(changes: Changes): SspLintSources {
  const base = cleanSources();
  const outcomes = base.view.evaluation.outcomes.map(
    (o) => changes.outcomes?.find((c) => c.requirementId === o.requirementId) ?? o,
  );
  const states = base.view.requirementStates.map((s) => {
    const change = changes.states?.find((c) => c.requirementId === s.requirementId);
    return change === undefined ? s : { ...s, ...change };
  });
  const view: View = { requirementStates: states, evaluation: { outcomes } };
  const poam =
    changes.openPoamRequirementIds === undefined
      ? base.view.openPoamRequirementIds
      : changes.openPoamRequirementIds;
  if (poam !== null && poam !== undefined) view.openPoamRequirementIds = poam;
  return {
    view,
    assets: changes.assets ?? base.assets,
    diagrams: changes.diagrams ?? base.diagrams,
    review: changes.review ?? base.review,
  };
}

/** One world per rule that fires that rule (and possibly others). */
export const RULE_FIXTURES: Record<SspLintRuleId, SspLintSources> = {
  ssp_requirement_not_met: sourcesWith({ outcomes: [outcome(SSP_ID, 'not_met')] }),
  no_assets: sourcesWith({ assets: [] }),
  out_of_scope_unjustified: sourcesWith({
    assets: [asset('a1', 'cui'), asset('a2', 'out_of_scope', '  ', 'Lobby kiosk')],
  }),
  no_network_diagram: sourcesWith({ diagrams: [diagram('d1', 'data_flow')] }),
  review_overdue: sourcesWith({
    review: { reviewOverdue: true, nextReviewDue: '2026-11-22', daysToReview: -3 },
  }),
  empty_statement: sourcesWith({
    states: [{ requirementId: 'AC.L2-3.1.5', implementationStatement: null }],
  }),
  not_met_without_poam: sourcesWith({ outcomes: [outcome('AC.L2-3.1.10', 'not_met')] }),
  na_without_rationale: sourcesWith({ outcomes: [outcome('AC.L2-3.1.1', 'met', 1)] }),
  future_tense: sourcesWith({
    states: [{ requirementId: 'AC.L2-3.1.9', implementationStatement: 'We will add MFA.' }],
  }),
  ssp_poam_mismatch: sourcesWith({ openPoamRequirementIds: ['AC.L2-3.1.5'] }),
  large_image: sourcesWith({
    diagrams: [diagram('d1', 'network', { embeddable: true, resolved: { size: 6 * MIB } })],
  }),
  image_limit: sourcesWith({
    diagrams: Array.from({ length: 11 }, (_, i) =>
      diagram(`d${String(i + 1)}`, 'network', { embeddable: true }),
    ),
  }),
};

/** A deep copy with every object and array frozen. */
export function deepFrozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    Object.freeze(v);
    for (const child of Object.values(v)) freeze(child);
  };
  freeze(copy);
  return copy;
}
