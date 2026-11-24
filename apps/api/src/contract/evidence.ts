import { z } from 'zod';
import { noteSchema, userRefSchema } from './common';
import { fileVersionSchema } from './files';

/** An evidence item links to at most every objective in the catalog. */
export const MAX_OBJECTIVE_LINKS = 320;

const titleSchema = z.string().trim().min(1).max(200);
const objectiveIdsSchema = z.array(z.string().min(1).max(64)).max(MAX_OBJECTIVE_LINKS);

/**
 * One version of an evidence item: a stored `file`, or for an item flagged "contains CUI" a
 * `reference` saying where the file really lives.
 */
export const evidenceVersionSchema = z.discriminatedUnion('kind', [
  fileVersionSchema.extend({ kind: z.literal('file') }),
  z.object({
    kind: z.literal('reference'),
    version: z.number().int().min(1),
    location: z.string(),
    note: z.string().nullable(),
    createdAt: z.iso.datetime(),
    createdBy: userRefSchema,
  }),
]);
export type EvidenceVersion = z.infer<typeof evidenceVersionSchema>;

/** An evidence item: `objectiveIds` in catalog order, `versions` newest first. */
export const evidenceItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  /** Fixed at creation. A flagged item never holds a file, only references. */
  containsCui: z.boolean(),
  objectiveIds: z.array(z.string()),
  versions: z.array(evidenceVersionSchema),
  createdAt: z.iso.datetime(),
  createdBy: userRefSchema,
  updatedAt: z.iso.datetime(),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

/** `GET /api/evidence`: sorted by title (case-insensitive), then `createdAt`, then `id`. */
export const evidenceListSchema = z.object({ items: z.array(evidenceItemSchema) });
export type EvidenceList = z.infer<typeof evidenceListSchema>;

/** `GET /api/evidence` query string. An objective not in the catalog is a 400. */
export const evidenceQuerySchema = z.strictObject({
  objectiveId: z.string().min(1).max(64).optional(),
});
export type EvidenceQuery = z.infer<typeof evidenceQuerySchema>;

/** `POST /api/evidence`. `objectiveIds` defaults to none; duplicates collapse on the server. */
export const createEvidenceRequestSchema = z.strictObject({
  title: titleSchema,
  description: noteSchema,
  containsCui: z.boolean(),
  objectiveIds: objectiveIdsSchema.default([]),
});
export type CreateEvidenceRequest = z.infer<typeof createEvidenceRequestSchema>;

/** `PATCH /api/evidence/:id`. At least one key. `containsCui` can't change, so it's refused. */
export const patchEvidenceRequestSchema = z
  .strictObject({
    title: titleSchema.optional(),
    description: noteSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchEvidenceRequest = z.infer<typeof patchEvidenceRequestSchema>;

/** `PUT /api/evidence/:id/objectives`: replaces the whole set. */
export const putEvidenceObjectivesRequestSchema = z.strictObject({
  objectiveIds: objectiveIdsSchema,
});
export type PutEvidenceObjectivesRequest = z.infer<typeof putEvidenceObjectivesRequestSchema>;

/** `POST /api/evidence/:id/references`: only on an item flagged "contains CUI". */
export const addReferenceRequestSchema = z.strictObject({
  location: z.string().trim().min(1).max(1000),
  note: noteSchema,
});
export type AddReferenceRequest = z.infer<typeof addReferenceRequestSchema>;

export const evidenceItemResponseSchema = z.object({ item: evidenceItemSchema });
export type EvidenceItemResponse = z.infer<typeof evidenceItemResponseSchema>;
