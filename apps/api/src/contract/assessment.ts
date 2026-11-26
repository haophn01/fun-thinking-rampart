import { z } from 'zod';
import {
  assessmentTypeSchema,
  calendarDateSchema,
  implementationLevelSchema,
  implementationStatementSchema,
  noteSchema,
  objectiveStatusSchema,
  userRefSchema,
} from './common';
import { closeoutClockSchema, evaluationSchema } from './evaluation';

export const assessmentSchema = z.object({
  id: z.string(),
  type: assessmentTypeSchema,
  conditionalStatusDate: calendarDateSchema.nullable(),
  catalogVersion: z.string(),
  updatedAt: z.iso.datetime(),
});
export type Assessment = z.infer<typeof assessmentSchema>;

export const objectiveResultSchema = z.object({
  objectiveId: z.string(),
  status: objectiveStatusSchema,
  note: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  updatedBy: userRefSchema,
});
export type ObjectiveResultRow = z.infer<typeof objectiveResultSchema>;

export const requirementStateSchema = z.object({
  requirementId: z.string(),
  implementationLevel: implementationLevelSchema.nullable(),
  implementationStatement: z.string().nullable(),
  owner: z.object({ id: z.string(), displayName: z.string(), active: z.boolean() }).nullable(),
  /**
   * The SSP's "planned to be implemented" text and the reason a requirement is not applicable.
   * The api always sends both; they are optional only so older mocks still parse.
   */
  plannedImplementation: z.string().nullable().optional(),
  naRationale: z.string().nullable().optional(),
  updatedAt: z.iso.datetime(),
});
export type RequirementState = z.infer<typeof requirementStateSchema>;

/**
 * `GET /api/assessment`. Both lists are in catalog order and hold only stored rows: a missing
 * objective result means not assessed, and a missing requirement state means empty.
 * `openPoamRequirementIds` lists the requirements with an open POA&M item, in catalog order: the
 * evaluation's input, so a client can recompute it. The api always sends it.
 */
export const assessmentViewSchema = z.object({
  assessment: assessmentSchema,
  objectiveResults: z.array(objectiveResultSchema),
  requirementStates: z.array(requirementStateSchema),
  openPoamRequirementIds: z.array(z.string()).optional(),
  evaluation: evaluationSchema,
  closeout: closeoutClockSchema.nullable(),
});
export type AssessmentView = z.infer<typeof assessmentViewSchema>;

/** `PATCH /api/assessment` (admin). At least one key; a `null` date clears it. */
export const updateAssessmentRequestSchema = z
  .strictObject({
    type: assessmentTypeSchema.optional(),
    conditionalStatusDate: calendarDateSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateAssessmentRequest = z.infer<typeof updateAssessmentRequestSchema>;

/** `PUT /api/assessment/objectives/:objectiveId`. Both keys are required; `note` may be null. */
export const putObjectiveResultRequestSchema = z.strictObject({
  status: objectiveStatusSchema,
  note: noteSchema,
});
export type PutObjectiveResultRequest = z.infer<typeof putObjectiveResultRequestSchema>;

export const objectiveWriteResponseSchema = z.object({
  objectiveResult: objectiveResultSchema,
  evaluation: evaluationSchema,
});
export type ObjectiveWriteResponse = z.infer<typeof objectiveWriteResponseSchema>;

/** `PATCH /api/assessment/requirements/:requirementId`. At least one key; `null` unsets. */
export const patchRequirementRequestSchema = z
  .strictObject({
    implementationStatement: implementationStatementSchema.optional(),
    implementationLevel: implementationLevelSchema.nullable().optional(),
    ownerId: z.uuid().nullable().optional(),
    plannedImplementation: implementationStatementSchema.optional(),
    naRationale: noteSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchRequirementRequest = z.infer<typeof patchRequirementRequestSchema>;

export const requirementWriteResponseSchema = z.object({
  requirementState: requirementStateSchema,
  evaluation: evaluationSchema,
});
export type RequirementWriteResponse = z.infer<typeof requirementWriteResponseSchema>;

export const ASSESSMENT_TYPE_LABELS = {
  self: 'Self-assessment',
  c3pao: 'C3PAO certification assessment',
} as const satisfies Record<z.infer<typeof assessmentTypeSchema>, string>;

/** Who confirms POA&M closeout, keyed by what `closeoutConfirmer` returns. */
export const CLOSEOUT_CONFIRMER_LABELS = {
  organization: 'Your organization',
  c3pao: 'An authorized C3PAO',
} as const;
