import { z } from 'zod';
import { noteSchema, userRefSchema } from './common';
import { fileVersionSchema } from './files';

/** A policy links to at most every requirement in the catalog. */
export const MAX_REQUIREMENT_LINKS = 110;

const titleSchema = z.string().trim().min(1).max(200);
const requirementIdsSchema = z.array(z.string().min(1).max(32)).max(MAX_REQUIREMENT_LINKS);

/** One version of a policy. Policies hold files only. */
export const policyVersionSchema = fileVersionSchema;
export type PolicyVersion = z.infer<typeof policyVersionSchema>;

/** A policy: `requirementIds` in catalog order, `versions` newest first. */
export const policySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  requirementIds: z.array(z.string()),
  versions: z.array(policyVersionSchema),
  createdAt: z.iso.datetime(),
  createdBy: userRefSchema,
  updatedAt: z.iso.datetime(),
});
export type Policy = z.infer<typeof policySchema>;

/** `GET /api/policies`: sorted by title (case-insensitive), then `createdAt`, then `id`. */
export const policyListSchema = z.object({ items: z.array(policySchema) });
export type PolicyList = z.infer<typeof policyListSchema>;

/** `GET /api/policies` query string. A requirement not in the catalog is a 400. */
export const policyQuerySchema = z.strictObject({
  requirementId: z.string().min(1).max(32).optional(),
});
export type PolicyQuery = z.infer<typeof policyQuerySchema>;

/** `POST /api/policies`. `requirementIds` defaults to none; duplicates collapse on the server. */
export const createPolicyRequestSchema = z.strictObject({
  title: titleSchema,
  description: noteSchema,
  requirementIds: requirementIdsSchema.default([]),
});
export type CreatePolicyRequest = z.infer<typeof createPolicyRequestSchema>;

/** `PATCH /api/policies/:id`. At least one key. */
export const patchPolicyRequestSchema = z
  .strictObject({
    title: titleSchema.optional(),
    description: noteSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchPolicyRequest = z.infer<typeof patchPolicyRequestSchema>;

/** `PUT /api/policies/:id/requirements`: replaces the whole set. */
export const putPolicyRequirementsRequestSchema = z.strictObject({
  requirementIds: requirementIdsSchema,
});
export type PutPolicyRequirementsRequest = z.infer<typeof putPolicyRequirementsRequestSchema>;

export const policyResponseSchema = z.object({ item: policySchema });
export type PolicyResponse = z.infer<typeof policyResponseSchema>;
