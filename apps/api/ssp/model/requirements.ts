// Section 3: each requirement in NIST wording, family by family. Its objectives are in Appendix B.
import type { Requirement } from '@rampart/catalog';
import {
  NIST_STATUS_LABELS,
  nistImplementationStatus,
  type AssessmentView,
  type EvidenceItem,
  type NistStatus,
  type Policy,
  type PoamItem,
  type RequirementState,
} from '../../src/contract';
import { NONE_RECORDED, familyHeading, field, heading, orElse, ownerName } from './common';
import { SSP_SECTIONS } from './sections';
import type { SspBlock, SspSource } from './types';

const NONE_LINKED = 'None linked';

/** What each implementation level reads as; the partial level reads as its catalog label. */
const LEVEL_NOT_SET = 'Not set (worst case)';
const LEVEL_NONE = 'Not implemented';

type Outcome = AssessmentView['evaluation']['outcomes'][number];

/** A requirement's NIST status; one with no outcome is not yet assessed. */
export function nistStatusOf(outcome: Outcome | undefined): NistStatus {
  return outcome === undefined ? 'not_assessed' : nistImplementationStatus(outcome);
}

/** What the requirement blocks look up, indexed once. */
interface Lookup {
  outcomes: ReadonlyMap<string, Outcome>;
  states: ReadonlyMap<string, RequirementState>;
  openItems: ReadonlyMap<string, PoamItem>;
  policies: readonly Policy[];
  evidence: readonly EvidenceItem[];
}

function lookupOf(source: SspSource): Lookup {
  const { view } = source;
  return {
    outcomes: new Map(view.evaluation.outcomes.map((o) => [o.requirementId, o])),
    states: new Map(view.requirementStates.map((s) => [s.requirementId, s])),
    openItems: new Map(
      source.poam.items.filter((i) => i.status === 'open').map((i) => [i.requirementId, i]),
    ),
    policies: source.policies,
    evidence: source.evidence,
  };
}

function levelLabel(requirement: Requirement, state: RequirementState | undefined): string | null {
  if (requirement.scoring.kind !== 'points' || requirement.scoring.partialCredit === null) {
    return null;
  }
  const level = state?.implementationLevel ?? null;
  if (level === null) return LEVEL_NOT_SET;
  return level === 'partial' ? requirement.scoring.partialCredit.label : LEVEL_NONE;
}

function requirementBlocks(requirement: Requirement, lookup: Lookup): SspBlock[] {
  const state = lookup.states.get(requirement.id);
  const level = levelLabel(requirement, state);
  const objectiveIds = new Set(requirement.objectives.map((o) => o.id));
  const item = lookup.openItems.get(requirement.id);
  return [
    heading(3, requirement.id),
    { kind: 'paragraph', text: requirement.text },
    field('Status', NIST_STATUS_LABELS[nistStatusOf(lookup.outcomes.get(requirement.id))]),
    field(
      'Points',
      requirement.scoring.kind === 'points' ? String(requirement.scoring.points) : 'Prerequisite',
    ),
    ...(level === null ? [] : [field('Implementation level', level)]),
    field('Owner', ownerName(state?.owner ?? null)),
    {
      kind: 'text',
      label: 'Current implementation',
      text: orElse(state?.implementationStatement, 'No implementation statement recorded.'),
    },
    {
      kind: 'text',
      label: 'Planned implementation',
      text: orElse(state?.plannedImplementation, NONE_RECORDED),
    },
    {
      kind: 'text',
      label: 'Rationale if not applicable',
      text: orElse(state?.naRationale, NONE_RECORDED),
    },
    {
      kind: 'list',
      label: 'Policies',
      items: lookup.policies
        .filter((p) => p.requirementIds.includes(requirement.id))
        .map((p) => p.title),
      empty: NONE_LINKED,
    },
    {
      kind: 'list',
      label: 'Evidence',
      items: lookup.evidence
        .filter((e) => e.objectiveIds.some((id) => objectiveIds.has(id)))
        .map((e) => e.title),
      empty: NONE_LINKED,
    },
    ...(item === undefined
      ? []
      : ([
          field('Open POA&M item', `Due ${item.due}`),
          { kind: 'text', label: 'Plan', text: item.plan },
        ] satisfies SspBlock[])),
  ];
}

/** The catalog's requirements, grouped by family code, in catalog order. */
export function byFamily(requirements: readonly Requirement[]): Map<string, Requirement[]> {
  const out = new Map<string, Requirement[]>();
  for (const requirement of requirements) {
    const list = out.get(requirement.family) ?? [];
    list.push(requirement);
    out.set(requirement.family, list);
  }
  return out;
}

export function requirementsBlocks(source: SspSource): SspBlock[] {
  const lookup = lookupOf(source);
  const families = byFamily(source.catalog.requirements);
  return [
    heading(1, SSP_SECTIONS.requirements),
    ...source.catalog.families.flatMap((family): SspBlock[] => [
      heading(2, familyHeading(family)),
      ...(families.get(family.code) ?? []).flatMap((r) => requirementBlocks(r, lookup)),
    ]),
  ];
}
