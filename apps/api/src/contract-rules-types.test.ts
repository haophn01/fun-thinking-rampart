// The contract can't import @rampart/rules (it must stay zod-only), so its evaluation schemas are
// hand-written mirrors. This test pins them to the frozen rules types: `tsc` fails on any drift,
// and the runtime half checks real rules output parses unchanged.
import { loadCatalog } from '@rampart/catalog';
import {
  computeScore,
  deriveRequirementOutcomes,
  evaluateAssessment,
  lintSspFrom,
  SSP_LINT_RULES,
  SSP_LINT_VERSION,
  type AssessmentInput,
  type Blocker,
  type CloseoutClock,
  type ConditionalResult,
  type EligibilityResult,
  type IneligibleCode,
  type RequirementOutcome,
  type RequirementStatus,
  type ScoreResult,
  type SspLintFinding,
  type SspLintRuleId,
  type SspLintSeverity,
  type SspLintSources,
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
  sspLintFindingSchema,
  sspLintResponseSchema,
  sspLintRuleIdSchema,
  sspLintSeveritySchema,
  type Asset,
  type AssessmentView,
  type DiagramLink,
  type DocumentControl,
  SSP_LARGE_IMAGE_BYTES,
  SSP_MAX_EMBEDDED_IMAGES,
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

  it('ssp lint mirror', () => {
    expectTypeOf<z.infer<typeof sspLintRuleIdSchema>>().toEqualTypeOf<SspLintRuleId>();
    expectTypeOf<z.infer<typeof sspLintSeveritySchema>>().toEqualTypeOf<SspLintSeverity>();
    expectTypeOf<z.infer<typeof sspLintFindingSchema>>().toEqualTypeOf<SspLintFinding>();
    expectTypeOf<z.infer<typeof sspLintResponseSchema>>().toEqualTypeOf<{
      version: string;
      findings: SspLintFinding[];
      counts: { errors: number; warnings: number };
    }>();
    // The api's own read shapes fit the lint's sources as they are.
    expectTypeOf<AssessmentView>().toExtend<SspLintSources['view']>();
    expectTypeOf<Asset[]>().toExtend<SspLintSources['assets']>();
    expectTypeOf<DiagramLink[]>().toExtend<SspLintSources['diagrams']>();
    expectTypeOf<DocumentControl>().toExtend<SspLintSources['review']>();

    // The mirror's rule ids are the rules' ids, in order.
    expect(sspLintRuleIdSchema.options).toEqual(SSP_LINT_RULES.map((r) => r.id));

    // Real output over the real catalog, in a world that fires every rule, parses unchanged.
    const catalog = loadCatalog();
    const ids = catalog.requirements.map((r) => r.id);
    const [first, second, third] = ids;
    const input: AssessmentInput = {
      // CA.L2-3.12.4 (the SSP requirement) is left not assessed.
      objectiveResults: catalog.requirements
        .filter((requirement) => requirement.scoring.kind !== 'prerequisite')
        .flatMap((requirement) =>
          requirement.objectives.map((objective, index) => ({
            objectiveId: objective.id,
            status:
              requirement.id === first
                ? ('not_met' as const)
                : requirement.id === second && index === 0
                  ? ('na' as const)
                  : ('met' as const),
          })),
        ),
      implementationLevels: {},
    };
    const evaluation = evaluateAssessment(catalog, input);
    const size = SSP_LARGE_IMAGE_BYTES + 1;
    const sources: SspLintSources = {
      view: {
        requirementStates: [
          { requirementId: second ?? '', implementationStatement: 'We will add MFA.' },
        ],
        openPoamRequirementIds: [third ?? ''],
        evaluation,
      },
      assets: [
        { id: 'a1', name: 'Kiosk', category: 'out_of_scope', outOfScopeJustification: null },
      ],
      diagrams: Array.from({ length: SSP_MAX_EMBEDDED_IMAGES + 1 }, (_, i) => ({
        id: `d${String(i)}`,
        caption: `Diagram ${String(i)}`,
        kind: 'data_flow',
        embeddable: true,
        resolved: { size },
      })),
      review: { reviewOverdue: true, nextReviewDue: '2026-11-01', daysToReview: -24 },
    };
    const findings = lintSspFrom(catalog, sources, {
      maxEmbeddedImages: SSP_MAX_EMBEDDED_IMAGES,
      largeImageBytes: SSP_LARGE_IMAGE_BYTES,
    });
    const response = {
      version: SSP_LINT_VERSION,
      findings,
      counts: {
        errors: findings.filter((f) => f.severity === 'error').length,
        warnings: findings.filter((f) => f.severity === 'warning').length,
      },
    };
    const fired = new Set(findings.map((f) => f.rule));
    expect([...fired].sort()).toEqual(
      SSP_LINT_RULES.map((r) => r.id)
        .filter((id) => id !== 'no_assets')
        .sort(),
    );
    expect(sspLintResponseSchema.parse(response)).toEqual(response);
    expect(sspLintFindingSchema.parse(findings[0])).toEqual(findings[0]);

    // Not loose: a bad rule or severity, or a missing field, fails.
    const good = findings[0];
    for (const bad of [
      { ...good, rule: 'no_such_rule' },
      { ...good, severity: 'info' },
      { ...good, subjectId: undefined },
      { ...good, hint: 1 },
    ]) {
      expect(sspLintFindingSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(sspLintResponseSchema.safeParse({ ...response, counts: { errors: 1 } }).success).toBe(
      false,
    );
    expect(sspLintResponseSchema.safeParse({ findings, counts: response.counts }).success).toBe(
      false,
    );
  });
});
