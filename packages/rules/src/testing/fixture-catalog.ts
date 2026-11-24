// Test-only catalog builder. It builds small, valid catalogs so the rules can be tested
// without the real Rev 2 data (that is R3's job against loadCatalog()).
import type {
  Catalog,
  Family,
  FamilyCode,
  ObjectiveId,
  Requirement,
  RequirementId,
  Scoring,
} from '@rampart/catalog';

// Test-table citations. The SPRS scoring methodology (points, partial credit and the SSP
// prerequisite) is 32 CFR 170.24(c)(2); requirement status comes from the plan's rule.
export const CFR_SCORING = '32 CFR 170.24(c)(2)';
export const PLAN_OBJECTIVES = 'plan: Objectives are first-class';

export type FixtureSpec =
  | { id: RequirementId; kind: 'points'; points: 1 | 3 | 5; objectives: number }
  | { id: RequirementId; kind: 'partial'; objectives: number }
  | { id: RequirementId; kind: 'prerequisite'; objectives: number };

/** The default fixture: one requirement of each scoring shape, with 3.1.9 before 3.1.10. */
export const DEFAULT_SPECS: readonly FixtureSpec[] = [
  { id: 'AC.L2-3.1.1', kind: 'points', points: 5, objectives: 3 },
  { id: 'AC.L2-3.1.5', kind: 'points', points: 3, objectives: 2 },
  { id: 'AC.L2-3.1.9', kind: 'points', points: 1, objectives: 1 },
  { id: 'AC.L2-3.1.10', kind: 'points', points: 1, objectives: 2 },
  { id: 'IA.L2-3.5.3', kind: 'partial', objectives: 2 },
  { id: 'CA.L2-3.12.4', kind: 'prerequisite', objectives: 2 },
];

const FAMILY_SECTIONS: Partial<Record<FamilyCode, string>> = {
  AC: '3.1',
  IA: '3.5',
  CA: '3.12',
  SC: '3.13',
};

function nistIdOf(id: RequirementId): string {
  const nistId = id.split('-')[1];
  if (nistId === undefined) throw new Error(`fixture id ${id} is not in CMMC form`);
  return nistId;
}

function familyOf(id: RequirementId): FamilyCode {
  const code = id.slice(0, 2) as FamilyCode;
  if (FAMILY_SECTIONS[code] === undefined) throw new Error(`fixture family ${code} is not set up`);
  return code;
}

function scoringOf(spec: FixtureSpec): Scoring {
  switch (spec.kind) {
    case 'points':
      return { kind: 'points', points: spec.points, citation: CFR_SCORING, partialCredit: null };
    case 'partial':
      return {
        kind: 'points',
        points: 5,
        citation: CFR_SCORING,
        partialCredit: { deduction: 3, label: 'Partially implemented', citation: CFR_SCORING },
      };
    case 'prerequisite':
      return { kind: 'prerequisite', citation: CFR_SCORING };
  }
}

/** Objective IDs of a requirement: "3.1.1[a]", "3.1.1[b]", ... */
export function objectiveIds(id: RequirementId, count: number): ObjectiveId[] {
  const nistId = nistIdOf(id);
  return Array.from({ length: count }, (_, i) => `${nistId}[${String.fromCharCode(97 + i)}]`);
}

export function fixtureCatalog(specs: readonly FixtureSpec[] = DEFAULT_SPECS): Catalog {
  const requirements: Requirement[] = specs.map((spec) => ({
    id: spec.id,
    nistId: nistIdOf(spec.id),
    family: familyOf(spec.id),
    type: 'derived',
    text: `Fixture requirement ${spec.id}`,
    scoring: scoringOf(spec),
    objectives: objectiveIds(spec.id, spec.objectives).map((id) => ({
      id,
      text: `Fixture objective ${id}`,
    })),
  }));
  const families: Family[] = [];
  for (const requirement of requirements) {
    let family = families.find((f) => f.code === requirement.family);
    if (family === undefined) {
      family = {
        code: requirement.family,
        nistSection: FAMILY_SECTIONS[requirement.family] ?? '',
        name: `Fixture family ${requirement.family}`,
        requirementIds: [],
      };
      families.push(family);
    }
    family.requirementIds.push(requirement.id);
  }
  return { id: 'nist-800-171-r2', version: '0.0.0-fixture', sources: [], families, requirements };
}
