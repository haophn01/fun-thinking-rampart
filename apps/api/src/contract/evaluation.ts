// Zod mirrors of the frozen @rampart/rules types. The contract may not import rules, so
// `src/contract-rules-types.test.ts` checks that these infer to exactly the rules types.
import { z } from 'zod';
import { implementationLevelSchema, requirementStatusSchema } from './common';

export const requirementOutcomeSchema = z.object({
  requirementId: z.string(),
  status: requirementStatusSchema,
  allNa: z.boolean(),
  counts: z.object({
    met: z.number(),
    not_met: z.number(),
    na: z.number(),
    not_assessed: z.number(),
  }),
  implementationLevel: implementationLevelSchema.nullable(),
  deduction: z.number(),
});

const deductionSchema = z.object({ requirementId: z.string(), points: z.number() });

export const scoreResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('scored'),
    score: z.number(),
    max: z.number(),
    floor: z.number(),
    deductions: z.array(deductionSchema),
    notAssessed: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('incomplete'),
    reason: z.literal('prerequisite_not_met'),
    prerequisites: z.array(z.string()),
    max: z.number(),
    floor: z.number(),
    notAssessed: z.array(z.string()),
  }),
]);

export const ineligibleCodeSchema = z.enum(['not_not_met', 'barred', 'exceeds_point_limit']);

/** What `checkPoamEligibility` returns: eligible, or every failing reason with its citation. */
export const eligibilityResultSchema = z.discriminatedUnion('eligible', [
  z.object({ eligible: z.literal(true) }),
  z.object({
    eligible: z.literal(false),
    reasons: z.array(z.object({ code: ineligibleCodeSchema, citation: z.string() })),
  }),
]);

/** What each ineligible reason reads as in the app. */
export const INELIGIBLE_REASON_LABELS = {
  not_not_met: 'Only Not Met requirements go on a POA&M',
  barred: 'This requirement can never go on a POA&M',
  exceeds_point_limit: "Worth more than 1 point, so it can't go on a POA&M",
} as const satisfies Record<z.infer<typeof ineligibleCodeSchema>, string>;

export const blockerSchema = z.discriminatedUnion('code', [
  z.object({
    code: z.literal('prerequisite_not_met'),
    requirementId: z.string(),
    citation: z.string(),
  }),
  z.object({ code: z.literal('not_assessed'), requirementIds: z.array(z.string()) }),
  z.object({
    code: z.literal('below_threshold'),
    score: z.number(),
    threshold: z.number(),
    citation: z.string(),
  }),
  z.object({
    code: z.literal('poam_ineligible'),
    requirementId: z.string(),
    reasons: z.array(ineligibleCodeSchema),
    citation: z.string(),
  }),
]);

export const conditionalResultSchema = z.object({
  status: z.enum(['final', 'conditional', 'not_eligible', 'incomplete']),
  blockers: z.array(blockerSchema),
});

export const closeoutClockSchema = z.object({
  conditionalStatusDate: z.string(),
  deadline: z.string(),
  daysRemaining: z.number(),
  expired: z.boolean(),
});

/** What `evaluateAssessment` returns; every assessment response carries one. */
export const evaluationSchema = z.object({
  outcomes: z.array(requirementOutcomeSchema),
  score: scoreResultSchema,
  conditional: conditionalResultSchema,
});
