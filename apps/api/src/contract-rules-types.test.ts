// The contract can't import @rampart/rules (it must stay zod-only), so its evaluation schemas are
// hand-written mirrors. This test pins them to the frozen rules types: `tsc` fails on any drift,
// and the runtime half checks real rules output parses unchanged.
import { loadCatalog } from '@rampart/catalog';
import {
  computeScore,
  deriveRequirementOutcomes,
  type AssessmentInput,
  type Blocker,
  type CloseoutClock,
  type ConditionalResult,
  type EligibilityResult,
  type IneligibleCode,
  type RequirementOutcome,
  type RequirementStatus,
  type ScoreResult,
} from '@rampart/rules';
import { checkConditional, checkPoamEligibility, closeoutClock } from '@rampart/rules/poam';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  blockerSchema,
  closeoutClockSchema,
  conditionalResultSchema,
  eligibilityResultSchema,
  evaluationSchema,
  ineligibleCodeSchema,
  requirementOutcomeSchema,
  scoreResultSchema,
} from './contract';

interface RulesEvaluation {
  outcomes: RequirementOutcome[];
  score: ScoreResult;
  conditional: ConditionalResult;
}

describe('contract evaluation mirrors', () => {
  it('mirrors match rules types', () => {
    expectTypeOf<z.infer<typeof requirementOutcomeSchema>>().toEqualTypeOf<RequirementOutcome>();
    expectTypeOf<z.infer<typeof scoreResultSchema>>().toEqualTypeOf<ScoreResult>();
    expectTypeOf<z.infer<typeof blockerSchema>>().toEqualTypeOf<Blocker>();
    expectTypeOf<z.infer<typeof conditionalResultSchema>>().toEqualTypeOf<ConditionalResult>();
    expectTypeOf<z.infer<typeof closeoutClockSchema>>().toEqualTypeOf<CloseoutClock>();
    expectTypeOf<z.infer<typeof evaluationSchema>>().toEqualTypeOf<RulesEvaluation>();

    const catalog = loadCatalog();
    const [first, second] = catalog.requirements;
    const objectives = [...(first?.objectives ?? []), ...(second?.objectives ?? [])];
    const inputs: AssessmentInput[] = [
      { objectiveResults: [], implementationLevels: {} },
      {
        objectiveResults: objectives.map((objective, index) => ({
          objectiveId: objective.id,
          status: index === 0 ? 'not_met' : 'met',
        })),
        implementationLevels: {},
      },
      {
        objectiveResults: catalog.requirements.flatMap((requirement) =>
          requirement.objectives.map((objective) => ({
            objectiveId: objective.id,
            status: 'met' as const,
          })),
        ),
        implementationLevels: {},
      },
      // An eligible Not Met requirement with no open POA&M item: a poam_missing blocker.
      {
        objectiveResults: catalog.requirements.flatMap((requirement) =>
          requirement.objectives.map((objective) => ({
            objectiveId: objective.id,
            status: requirement.id === 'AC.L2-3.1.10' ? ('not_met' as const) : ('met' as const),
          })),
        ),
        implementationLevels: {},
        openPoamRequirementIds: [],
      },
    ];
    const kinds = new Set<string>();
    const blockerCodes = new Set<string>();
    for (const input of inputs) {
      const outcomes = deriveRequirementOutcomes(catalog, input);
      const score = computeScore(catalog, input);
      const conditional = checkConditional(
        catalog,
        outcomes,
        score,
        undefined,
        input.openPoamRequirementIds,
      );
      const evaluation: RulesEvaluation = { outcomes, score, conditional };
      kinds.add(`${score.kind}/${conditional.status}`);
      for (const blocker of conditional.blockers) blockerCodes.add(blocker.code);
      expect(evaluationSchema.parse(evaluation)).toEqual(evaluation);
    }
    expect(kinds.size).toBeGreaterThan(1);
    expect(blockerCodes).toContain('poam_missing');

    for (const clock of [
      closeoutClock('2026-11-23', '2026-11-23'),
      closeoutClock('2026-01-01', '2026-11-23'),
    ]) {
      expect(closeoutClockSchema.parse(clock)).toEqual(clock);
    }

    // The mirrors are not loose: an off-contract shape fails.
    expect(scoreResultSchema.safeParse({ kind: 'scored', score: 110 }).success).toBe(false);
    expect(blockerSchema.safeParse({ code: 'below_threshold', score: 1 }).success).toBe(false);
    expect(blockerSchema.safeParse({ code: 'poam_missing', requirementId: 'x' }).success).toBe(
      false,
    );
  });

  it('eligibility mirror', () => {
    expectTypeOf<z.infer<typeof eligibilityResultSchema>>().toEqualTypeOf<EligibilityResult>();
    expectTypeOf<z.infer<typeof ineligibleCodeSchema>>().toEqualTypeOf<IneligibleCode>();

    // Real rules output, eligible and not, with one and two reasons, parses unchanged.
    const catalog = loadCatalog();
    const statuses: RequirementStatus[] = ['met', 'not_met', 'not_assessed'];
    const seen = new Set<string>();
    for (const requirement of catalog.requirements) {
      for (const status of statuses) {
        const result = checkPoamEligibility(catalog, { requirementId: requirement.id, status });
        seen.add(result.eligible ? 'eligible' : String(result.reasons.length));
        expect(eligibilityResultSchema.parse(result)).toEqual(result);
      }
    }
    expect([...seen].sort()).toEqual(['1', '2', 'eligible']);

    // Not loose: each branch needs its own shape, and the codes are exact.
    for (const bad of [
      { eligible: false },
      { eligible: false, reasons: [{ code: 'barred' }] },
      { eligible: false, reasons: [{ code: 'unknown', citation: 'x' }] },
      { eligible: 'yes' },
      {},
    ]) {
      expect(eligibilityResultSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
