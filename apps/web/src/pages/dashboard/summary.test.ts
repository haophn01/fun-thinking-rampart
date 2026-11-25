import { loadCatalog } from '@rampart/catalog';
import { describe, expect, it } from 'vitest';
import { familyRows, objectiveCounts } from './summary';

const catalog = loadCatalog();

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture missing');
  return value;
}

const ALL = catalog.requirements.flatMap((r) => r.objectives.map((o) => o.id));

describe('objective and family counts', () => {
  it('counts every catalog objective, a missing result as not assessed', () => {
    const results = [
      { objectiveId: must(ALL[0]), status: 'met' as const },
      { objectiveId: must(ALL[1]), status: 'met' as const },
      { objectiveId: must(ALL[2]), status: 'not_met' as const },
      { objectiveId: must(ALL[3]), status: 'na' as const },
      { objectiveId: must(ALL[4]), status: 'not_assessed' as const },
      { objectiveId: 'not-in-catalog', status: 'met' as const },
    ];
    const counts = objectiveCounts(results, catalog);
    expect(counts).toEqual({
      met: 2,
      not_met: 1,
      na: 1,
      not_assessed: ALL.length - 4,
      total: ALL.length,
    });
    expect(counts.met + counts.not_met + counts.na + counts.not_assessed).toBe(counts.total);
  });

  it('an empty result list is all not assessed', () => {
    const counts = objectiveCounts([], catalog);
    expect(counts.not_assessed).toBe(counts.total);
    expect(counts.met).toBe(0);
  });

  it('family rows give assessed percent and met / not met requirement counts', () => {
    const family = must(catalog.families[0]);
    const reqs = catalog.requirements.filter((r) => r.family === family.code);
    const famObjectives = reqs.flatMap((r) => r.objectives.map((o) => o.id));
    const results = famObjectives.slice(0, 1).map((objectiveId) => ({
      objectiveId,
      status: 'met' as const,
    }));
    const outcomes = [
      { requirementId: must(reqs[0]).id, status: 'met' as const },
      { requirementId: must(reqs[1]).id, status: 'not_met' as const },
      { requirementId: must(reqs[2]).id, status: 'not_met' as const },
      { requirementId: must(reqs[3]).id, status: 'not_assessed' as const },
    ];
    const rows = familyRows(results, outcomes, catalog);
    expect(rows).toHaveLength(catalog.families.length);
    expect(rows[0]).toMatchObject({
      code: family.code,
      name: family.name,
      objectives: famObjectives.length,
      assessed: 1,
      percent: Math.round(100 / famObjectives.length),
      met: 1,
      notMet: 2,
    });
    expect(rows[1]).toMatchObject({ assessed: 0, percent: 0, met: 0, notMet: 0 });
  });

  it('a not-applicable objective counts as assessed', () => {
    const family = must(catalog.families[0]);
    const famObjectives = catalog.requirements
      .filter((r) => r.family === family.code)
      .flatMap((r) => r.objectives.map((o) => o.id));
    const results = famObjectives.map((objectiveId) => ({ objectiveId, status: 'na' as const }));
    expect(familyRows(results, [], catalog)[0]).toMatchObject({ percent: 100 });
  });
});
