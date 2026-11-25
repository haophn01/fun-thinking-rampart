import { loadCatalog } from '@rampart/catalog';
import { evaluateAssessment } from '@rampart/rules';
import { describe, expect, it } from 'vitest';
import { toAssessmentInput } from './input';

const catalog = loadCatalog();
const AT = '2026-01-01T00:00:00.000Z';
const user = { id: 'u1', displayName: 'Ada' };

function view() {
  const objectiveResults = catalog.requirements.flatMap((r) =>
    r.objectives.map((o) => ({
      objectiveId: o.id,
      status: r.id === 'AC.L2-3.1.1' ? ('not_met' as const) : ('met' as const),
      note: null,
      updatedAt: AT,
      updatedBy: user,
    })),
  );
  const requirementStates = [
    {
      requirementId: 'IA.L2-3.5.3',
      implementationLevel: 'partial' as const,
      implementationStatement: null,
      owner: null,
      updatedAt: AT,
    },
    {
      requirementId: 'AC.L2-3.1.2',
      implementationLevel: null,
      implementationStatement: 'text',
      owner: null,
      updatedAt: AT,
    },
  ];
  return { objectiveResults, requirementStates };
}

describe('view to rules input', () => {
  it('maps results and levels from a view', () => {
    const input = toAssessmentInput(view());
    expect(input.objectiveResults).toHaveLength(view().objectiveResults.length);
    expect(input.objectiveResults[0]).toEqual({ objectiveId: '3.1.1[a]', status: 'not_met' });
    expect(Object.keys(input.objectiveResults[0] ?? {}).sort()).toEqual(['objectiveId', 'status']);
    expect(input.implementationLevels).toEqual({ 'IA.L2-3.5.3': 'partial' });
  });

  it('with no changes evaluateAssessment deep-equals the view evaluation', () => {
    const v = view();
    const input = toAssessmentInput(v);
    // The API computes the view's evaluation from the same stored rows.
    const fromRows = evaluateAssessment(catalog, {
      objectiveResults: v.objectiveResults.map((r) => ({
        objectiveId: r.objectiveId,
        status: r.status,
      })),
      implementationLevels: { 'IA.L2-3.5.3': 'partial' },
    });
    expect(evaluateAssessment(catalog, input)).toEqual(fromRows);
  });

  it('carries open POA&M list', () => {
    // AC.L2-3.1.3 is an eligible 1-point requirement; AC.L2-3.1.1 (5 points) is ineligible.
    const v = view();
    const eligible = 'AC.L2-3.1.3';
    const [firstObjective] = catalog.requirements.find((r) => r.id === eligible)?.objectives ?? [];
    if (!firstObjective) throw new Error('no objective');
    const rows = {
      ...v,
      objectiveResults: v.objectiveResults.map((r) =>
        r.objectiveId === firstObjective.id ? { ...r, status: 'not_met' as const } : r,
      ),
    };

    // Absent in the view: absent in the input, so no POA&M check runs.
    expect('openPoamRequirementIds' in toAssessmentInput(rows)).toBe(false);

    // Present: passed on as a copy, and the local evaluation equals the api's.
    const list = [eligible];
    const input = toAssessmentInput({ ...rows, openPoamRequirementIds: list });
    expect(input.openPoamRequirementIds).toEqual([eligible]);
    expect(input.openPoamRequirementIds).not.toBe(list);
    const api = (openPoamRequirementIds: string[]) =>
      evaluateAssessment(catalog, {
        objectiveResults: rows.objectiveResults.map((r) => ({
          objectiveId: r.objectiveId,
          status: r.status,
        })),
        implementationLevels: { 'IA.L2-3.5.3': 'partial' },
        openPoamRequirementIds,
      });
    expect(evaluateAssessment(catalog, input)).toEqual(api([eligible]));

    // An empty list: the uncovered eligible requirement shows poam_missing, as the api says.
    const uncovered = evaluateAssessment(
      catalog,
      toAssessmentInput({ ...rows, openPoamRequirementIds: [] }),
    );
    expect(uncovered).toEqual(api([]));
    expect(
      uncovered.conditional.blockers
        .filter((b) => b.code === 'poam_missing')
        .map((b) => b.requirementId),
    ).toEqual([eligible]);
  });

  it('an empty view gives an empty input', () => {
    expect(toAssessmentInput({ objectiveResults: [], requirementStates: [] })).toEqual({
      objectiveResults: [],
      implementationLevels: {},
    });
  });
});
