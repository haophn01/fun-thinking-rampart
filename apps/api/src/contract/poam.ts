import { z } from 'zod';
import { calendarDateSchema, noteSchema, requirementStatusSchema, userRefSchema } from './common';
import { closeoutClockSchema, eligibilityResultSchema } from './evaluation';

/** Who confirms a closeout: what `closeoutConfirmer(assessment.type)` returns. */
export const closeoutConfirmerSchema = z.enum(['organization', 'c3pao']);
export type CloseoutConfirmer = z.infer<typeof closeoutConfirmerSchema>;

export const poamItemStatusSchema = z.enum(['open', 'closed']);
export type PoamItemStatus = z.infer<typeof poamItemStatusSchema>;

/** At most this many milestones per item. */
export const MAX_MILESTONES = 20;

/** One milestone in a request: a title, its due date, and the day it was done (or `null`). */
export const milestoneSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  due: calendarDateSchema,
  doneOn: calendarDateSchema.nullable(),
});
export type Milestone = z.infer<typeof milestoneSchema>;

/** An item's milestones, in the order sent. */
export const milestonesSchema = z.array(milestoneSchema).max(MAX_MILESTONES);

const planSchema = z.string().trim().min(1).max(20000);

const storedMilestoneSchema = z.object({
  title: z.string(),
  due: calendarDateSchema,
  doneOn: calendarDateSchema.nullable(),
});

const ownerSchema = z.object({ id: z.string(), displayName: z.string(), active: z.boolean() });

export const poamCloseoutSchema = z.object({
  closedOn: calendarDateSchema,
  note: z.string().nullable(),
  confirmedBy: closeoutConfirmerSchema,
  c3paoName: z.string().nullable(),
  recordedBy: userRefSchema,
  /** `closedOn` is after the closeout deadline. */
  late: z.boolean(),
});
export type PoamCloseout = z.infer<typeof poamCloseoutSchema>;

/**
 * One POA&M item: its stored fields, its closeout (exactly when it's closed), and the fields
 * derived at read time from the requirement's current status and the app clock's UTC date.
 */
export const poamItemSchema = z
  .object({
    id: z.string(),
    requirementId: z.string(),
    status: poamItemStatusSchema,
    plan: z.string(),
    due: calendarDateSchema,
    milestones: z.array(storedMilestoneSchema),
    owner: ownerSchema.nullable(),
    createdAt: z.iso.datetime(),
    createdBy: userRefSchema,
    updatedAt: z.iso.datetime(),
    closeout: poamCloseoutSchema.nullable(),
    requirementStatus: requirementStatusSchema,
    eligibility: eligibilityResultSchema,
    /** `due` minus today, in days; negative once it's past. */
    daysToDue: z.number().int(),
    /** Open, and today is after `due`. */
    overdue: z.boolean(),
    /** A closeout deadline exists and `due` is after it. */
    dueAfterDeadline: z.boolean(),
    /** Open, and the requirement is `met`. */
    readyToClose: z.boolean(),
  })
  .refine((item) => (item.status === 'closed') === (item.closeout !== null), {
    message: 'An item is closed exactly when it has a closeout',
    path: ['closeout'],
  });
export type PoamItem = z.infer<typeof poamItemSchema>;

export const poamViewCandidateSchema = z.object({
  requirementId: z.string(),
  eligibility: eligibilityResultSchema,
});
export type PoamViewCandidate = z.infer<typeof poamViewCandidateSchema>;

/**
 * `GET /api/poam`: open items by `due` then catalog order, then closed items newest closeout
 * first; every Not Met requirement with no open item as a candidate, in catalog order.
 */
export const poamViewSchema = z.object({
  items: z.array(poamItemSchema),
  candidates: z.array(poamViewCandidateSchema),
  closeout: closeoutClockSchema.nullable(),
  confirmer: closeoutConfirmerSchema,
});
export type PoamView = z.infer<typeof poamViewSchema>;

/** `POST /api/poam`. `milestones` defaults to none; `ownerId: null` leaves it unassigned. */
export const createPoamItemRequestSchema = z.strictObject({
  requirementId: z.string().min(1).max(32),
  plan: planSchema,
  due: calendarDateSchema,
  ownerId: z.uuid().nullable().optional(),
  milestones: milestonesSchema.default([]),
});
export type CreatePoamItemRequest = z.infer<typeof createPoamItemRequestSchema>;

/** `PATCH /api/poam/:id`. At least one key; `milestones` replaces the whole list. */
export const patchPoamItemRequestSchema = z
  .strictObject({
    plan: planSchema.optional(),
    due: calendarDateSchema.optional(),
    ownerId: z.uuid().nullable().optional(),
    milestones: milestonesSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchPoamItemRequest = z.infer<typeof patchPoamItemRequestSchema>;

/**
 * `POST /api/poam/:id/closeout` (admin). `c3paoName` is required for a C3PAO assessment and
 * refused for a self-assessment; the route checks that against the assessment's type.
 */
export const closeoutRequestSchema = z.strictObject({
  closedOn: calendarDateSchema,
  note: noteSchema,
  c3paoName: z.string().trim().min(1).max(200).nullable().optional(),
});
export type CloseoutRequest = z.infer<typeof closeoutRequestSchema>;

export const poamItemResponseSchema = z.object({ item: poamItemSchema });
export type PoamItemResponse = z.infer<typeof poamItemResponseSchema>;
