// Zod mirror of the @rampart/rules SSP lint types. The contract may not import rules, so
// `src/contract-rules-types.test.ts` checks that these infer to exactly the rules types.
import { z } from 'zod';

/** The lint's rule ids, in the order findings come in (`SSP_LINT_RULES`). */
export const sspLintRuleIdSchema = z.enum([
  'ssp_requirement_not_met',
  'no_assets',
  'out_of_scope_unjustified',
  'no_network_diagram',
  'review_overdue',
  'empty_statement',
  'not_met_without_poam',
  'na_without_rationale',
  'future_tense',
  'ssp_poam_mismatch',
  'large_image',
  'image_limit',
]);
export type SspLintRuleId = z.infer<typeof sspLintRuleIdSchema>;

export const sspLintSeveritySchema = z.enum(['error', 'warning']);
export type SspLintSeverity = z.infer<typeof sspLintSeveritySchema>;

/** One finding. `subjectId` is the asset or diagram link id; `hint` is the rule's hint. */
export const sspLintFindingSchema = z.object({
  rule: sspLintRuleIdSchema,
  severity: sspLintSeveritySchema,
  requirementId: z.string().nullable(),
  subjectId: z.string().nullable(),
  message: z.string(),
  hint: z.string(),
});
export type SspLintFinding = z.infer<typeof sspLintFindingSchema>;

/** `GET /api/ssp/lint`: the rules' version, the findings in rule order, and their counts. */
export const sspLintResponseSchema = z.object({
  version: z.string(),
  findings: z.array(sspLintFindingSchema),
  counts: z.object({ errors: z.number().int(), warnings: z.number().int() }),
});
export type SspLintResponse = z.infer<typeof sspLintResponseSchema>;
