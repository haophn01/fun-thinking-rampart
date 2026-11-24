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
  type RequirementOutcome,
  type ScoreResult,
} from '@rampart/rules';
import { checkConditional, closeoutClock } from '@rampart/rules/poam';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  blockerSchema,
  closeoutClockSchema,
  conditionalResultSchema,
  evaluationSchema,
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
    ];
    const kinds = new Set<string>();
    for (const input of inputs) {
      const outcomes = deriveRequirementOutcomes(catalog, input);
      const score = computeScore(catalog, input);
      const conditional = checkConditional(catalog, outcomes, score);
      const evaluation: RulesEvaluation = { outcomes, score, conditional };
      kinds.add(`${score.kind}/${conditional.status}`);
      expect(evaluationSchema.parse(evaluation)).toEqual(evaluation);
    }
    expect(kinds.size).toBeGreaterThan(1);

    for (const clock of [
      closeoutClock('2026-11-23', '2026-11-23'),
      closeoutClock('2026-01-01', '2026-11-23'),
    ]) {
      expect(closeoutClockSchema.parse(clock)).toEqual(clock);
    }

    // The mirrors are not loose: an off-contract shape fails.
    expect(scoreResultSchema.safeParse({ kind: 'scored', score: 110 }).success).toBe(false);
    expect(blockerSchema.safeParse({ code: 'below_threshold', score: 1 }).success).toBe(false);
  });
});
