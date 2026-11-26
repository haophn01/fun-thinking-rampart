// The SSP's own data beyond the system profile: identification, CUI, environment and review
// details, system roles, assets, service providers and their responsibilities, diagram links and
// document control. Request schemas trim and turn blank text into null; responses are plain.
import { z } from 'zod';
import {
  calendarDateSchema,
  emailSchema,
  noteSchema,
  requirementStatusSchema,
  userRefSchema,
} from './common';

// ---------------------------------------------------------------------------------------------
// Enums, labels and defaults. Every list is in the order the export prints it.

export const ASSET_CATEGORIES = ['cui', 'spa', 'crma', 'specialized', 'out_of_scope'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];
export const ASSET_CATEGORY_LABELS = {
  cui: 'CUI Assets',
  spa: 'Security Protection Assets',
  crma: 'Contractor Risk Managed Assets',
  specialized: 'Specialized Assets',
  out_of_scope: 'Out-of-Scope Assets',
} as const satisfies Record<AssetCategory, string>;

export const PROVIDER_TYPES = ['cloud', 'msp', 'mssp', 'other'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];
export const PROVIDER_TYPE_LABELS = {
  cloud: 'Cloud service provider',
  msp: 'Managed service provider',
  mssp: 'Managed security service provider',
  other: 'Other',
} as const satisfies Record<ProviderType, string>;

export const RESPONSIBILITY_PARTIES = ['organization', 'esp', 'shared'] as const;
export type ResponsibilityParty = (typeof RESPONSIBILITY_PARTIES)[number];
export const RESPONSIBILITY_PARTY_LABELS = {
  organization: 'Organization',
  esp: 'ESP',
  shared: 'Shared',
} as const satisfies Record<ResponsibilityParty, string>;

export const DIAGRAM_KINDS = ['network', 'data_flow', 'other'] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];
export const DIAGRAM_KIND_LABELS = {
  network: 'Network diagram',
  data_flow: 'CUI data flow',
  other: 'Other diagram',
} as const satisfies Record<DiagramKind, string>;

/** `export`: written by an SSP export; `manual`: entered by a user. */
export const REVISION_KINDS = ['export', 'manual'] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

/** A requirement's implementation status in NIST SP 800-171 SSP wording. */
export const NIST_STATUSES = ['implemented', 'planned', 'not_applicable', 'not_assessed'] as const;
export type NistStatus = (typeof NIST_STATUSES)[number];
export const NIST_STATUS_LABELS = {
  implemented: 'Implemented',
  planned: 'Planned to be implemented',
  not_applicable: 'Not applicable',
  not_assessed: 'Not yet assessed',
} as const satisfies Record<NistStatus, string>;

/** What the security categorization reads as while it is unset (stored null). */
export const DEFAULT_CATEGORIZATION = 'Moderate impact for confidentiality';

export const DEFAULT_REVIEW_CADENCE_MONTHS = 12;

/** Diagram files the export may embed as pictures, compared case-insensitively. */
export const EMBEDDABLE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

/**
 * The NIST status for a requirement's status. `allNa` is whether every objective is N/A: a met
 * requirement with only some N/A objectives is still implemented.
 */
export function nistImplementationStatus(input: {
  status: z.infer<typeof requirementStatusSchema>;
  allNa: boolean;
}): NistStatus {
  switch (input.status) {
    case 'met':
      return input.allNa ? 'not_applicable' : 'implemented';
    case 'not_met':
      return 'planned';
    case 'not_assessed':
      return 'not_assessed';
  }
}

/** Whether a file name's last extension is one of `EMBEDDABLE_IMAGE_EXTENSIONS`. */
export function isEmbeddableImage(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = fileName.slice(dot).toLowerCase();
  return EMBEDDABLE_IMAGE_EXTENSIONS.some((allowed) => allowed === extension);
}

// ---------------------------------------------------------------------------------------------
// Shared request pieces.

/** Trims; empty or whitespace-only becomes null, and anything else must pass `value`. */
function blankToNull<T extends z.ZodType<string | null, string>>(value: T) {
  return z
    .string()
    .trim()
    .transform((text) => (text === '' ? null : text))
    .pipe(z.union([z.null(), value]))
    .nullable();
}

/** Optional free text of at most `max` characters after trimming; blank is null. */
const text = (max: number) => blankToNull(z.string().max(max));

/** Required text: trimmed, 1 to `max` characters, so blank is refused. */
const requiredText = (max: number) => z.string().trim().min(1).max(max);

/** At least one key: a patch that names nothing is a 400. */
const SOMETHING_TO_CHANGE = {
  check: (body: object) => Object.keys(body).length > 0,
  message: 'Nothing to change',
} as const;

const PHONE = /^([0-9+().\- ]+?)(?: (?:x|ext\.?) ?\d{1,10})?$/i;

/** 7-50 of digits, `+ ( ) . -` and spaces, with at least one digit, then an optional extension. */
function isPhone(value: string): boolean {
  const match = PHONE.exec(value);
  const number = match?.[1];
  return number !== undefined && number.length >= 7 && number.length <= 50 && /\d/.test(number);
}

const phoneSchema = blankToNull(
  z.string().refine(isPhone, {
    message: 'A phone number is 7 to 50 digits, spaces and + ( ) . -, then an optional " x123"',
  }),
);

const timestamp = z.iso.datetime();

// ---------------------------------------------------------------------------------------------
// SSP profile: one per assessment.

export const SSP_PROFILE_GROUPS = ['identification', 'cui', 'environment', 'review'] as const;
export type SspProfileGroup = (typeof SSP_PROFILE_GROUPS)[number];

/** The profile's fields, in the order the SSP and the form show them. */
export const SSP_PROFILE_FIELDS = [
  { key: 'categorization', label: 'Security categorization', group: 'identification' },
  { key: 'securityOfficer', label: 'System security officer', group: 'identification' },
  {
    key: 'securityOfficerEmail',
    label: 'System security officer email',
    group: 'identification',
  },
  { key: 'organizationAddress', label: 'Organization address', group: 'identification' },
  { key: 'organizationPhone', label: 'Organization phone', group: 'identification' },
  { key: 'cuiCategories', label: 'CUI categories (CUI Registry)', group: 'cui' },
  { key: 'cuiLocations', label: 'Where CUI is stored, processed or transmitted', group: 'cui' },
  { key: 'cuiEntryExit', label: 'How CUI enters and leaves the system', group: 'cui' },
  { key: 'topologyNarrative', label: 'Network topology', group: 'environment' },
  { key: 'dataFlowNarrative', label: 'CUI data flow', group: 'environment' },
  { key: 'inventoryReference', label: 'Hardware and software inventory', group: 'environment' },
  { key: 'maintenanceStatement', label: 'Maintenance and ownership', group: 'environment' },
  { key: 'reviewCadenceMonths', label: 'Review every (months)', group: 'review' },
  { key: 'nextReviewDate', label: 'Next review date', group: 'review' },
] as const satisfies readonly { key: string; label: string; group: SspProfileGroup }[];

export type SspProfileFieldKey = (typeof SSP_PROFILE_FIELDS)[number]['key'];

/** The request-side rule for each field. */
const PROFILE_RULES = {
  /** Null or blank resets it to `DEFAULT_CATEGORIZATION` (stored null). */
  categorization: text(200),
  securityOfficer: text(200),
  securityOfficerEmail: blankToNull(emailSchema),
  organizationAddress: text(1000),
  organizationPhone: phoneSchema,
  cuiCategories: text(20000),
  cuiLocations: text(20000),
  cuiEntryExit: text(20000),
  topologyNarrative: text(20000),
  dataFlowNarrative: text(20000),
  /** A narrative or a URL. */
  inventoryReference: text(2000),
  maintenanceStatement: text(20000),
  /** Never null: it always has a value, 12 by default. */
  reviewCadenceMonths: z.number().int().min(1).max(60),
  /** Any real date, a past one included. */
  nextReviewDate: calendarDateSchema.nullable(),
} satisfies Record<SspProfileFieldKey, z.ZodType>;

const nullableString = z.string().nullable();

/**
 * The SSP profile as read. With no saved row every field is null except `categorization`
 * (`DEFAULT_CATEGORIZATION`) and `reviewCadenceMonths` (12); `updatedAt`/`updatedBy` are null
 * until the first save.
 */
export const sspProfileSchema = z.object({
  categorization: z.string(),
  securityOfficer: nullableString,
  securityOfficerEmail: nullableString,
  organizationAddress: nullableString,
  organizationPhone: nullableString,
  cuiCategories: nullableString,
  cuiLocations: nullableString,
  cuiEntryExit: nullableString,
  topologyNarrative: nullableString,
  dataFlowNarrative: nullableString,
  inventoryReference: nullableString,
  maintenanceStatement: nullableString,
  reviewCadenceMonths: z.number().int(),
  nextReviewDate: calendarDateSchema.nullable(),
  updatedAt: timestamp.nullable(),
  updatedBy: userRefSchema.nullable(),
});
export type SspProfile = z.infer<typeof sspProfileSchema>;

/** `GET` and `PATCH /api/ssp/profile`. */
export const sspProfileResponseSchema = z.object({ profile: sspProfileSchema });
export type SspProfileResponse = z.infer<typeof sspProfileResponseSchema>;

/** `PATCH /api/ssp/profile`: any of the fields, at least one. */
export const patchSspProfileRequestSchema = z
  .strictObject({
    categorization: PROFILE_RULES.categorization.optional(),
    securityOfficer: PROFILE_RULES.securityOfficer.optional(),
    securityOfficerEmail: PROFILE_RULES.securityOfficerEmail.optional(),
    organizationAddress: PROFILE_RULES.organizationAddress.optional(),
    organizationPhone: PROFILE_RULES.organizationPhone.optional(),
    cuiCategories: PROFILE_RULES.cuiCategories.optional(),
    cuiLocations: PROFILE_RULES.cuiLocations.optional(),
    cuiEntryExit: PROFILE_RULES.cuiEntryExit.optional(),
    topologyNarrative: PROFILE_RULES.topologyNarrative.optional(),
    dataFlowNarrative: PROFILE_RULES.dataFlowNarrative.optional(),
    inventoryReference: PROFILE_RULES.inventoryReference.optional(),
    maintenanceStatement: PROFILE_RULES.maintenanceStatement.optional(),
    reviewCadenceMonths: PROFILE_RULES.reviewCadenceMonths.optional(),
    nextReviewDate: PROFILE_RULES.nextReviewDate.optional(),
  })
  .refine(SOMETHING_TO_CHANGE.check, { message: SOMETHING_TO_CHANGE.message });
export type PatchSspProfileRequest = z.infer<typeof patchSspProfileRequestSchema>;

// ---------------------------------------------------------------------------------------------
// System roles: who uses the system, and how many of them are privileged.

export const systemRoleSchema = z.object({
  id: z.string(),
  title: z.string(),
  person: nullableString,
  responsibilities: nullableString,
  userCount: z.number().int(),
  privileged: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SystemRole = z.infer<typeof systemRoleSchema>;

const roleFields = {
  title: requiredText(200),
  person: text(200),
  responsibilities: text(4000),
  userCount: z.number().int().min(0).max(1_000_000),
  privileged: z.boolean(),
};

/** `POST /api/ssp/roles`. `person` and `responsibilities` default to null. */
export const createSystemRoleRequestSchema = z.strictObject({
  title: roleFields.title,
  person: roleFields.person.default(null),
  responsibilities: roleFields.responsibilities.default(null),
  userCount: roleFields.userCount,
  privileged: roleFields.privileged,
});
export type CreateSystemRoleRequest = z.infer<typeof createSystemRoleRequestSchema>;

/** `PATCH /api/ssp/roles/:id`: at least one key. */
export const patchSystemRoleRequestSchema = z
  .strictObject({
    title: roleFields.title.optional(),
    person: roleFields.person.optional(),
    responsibilities: roleFields.responsibilities.optional(),
    userCount: roleFields.userCount.optional(),
    privileged: roleFields.privileged.optional(),
  })
  .refine(SOMETHING_TO_CHANGE.check, { message: SOMETHING_TO_CHANGE.message });
export type PatchSystemRoleRequest = z.infer<typeof patchSystemRoleRequestSchema>;

/**
 * `GET /api/ssp/roles`, by `createdAt` then `id`. `totals.users` sums every live role's
 * `userCount`; `totals.privilegedUsers` sums the privileged ones.
 */
export const rolesResponseSchema = z.object({
  roles: z.array(systemRoleSchema),
  totals: z.object({ users: z.number().int(), privilegedUsers: z.number().int() }),
});
export type RolesResponse = z.infer<typeof rolesResponseSchema>;

export const roleResponseSchema = z.object({ role: systemRoleSchema });
export type RoleResponse = z.infer<typeof roleResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Assets, by CMMC asset category.

export const assetCategorySchema = z.enum(ASSET_CATEGORIES);

export const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: assetCategorySchema,
  assetType: nullableString,
  owner: nullableString,
  location: nullableString,
  treatment: nullableString,
  outOfScopeJustification: nullableString,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Asset = z.infer<typeof assetSchema>;

const assetFields = {
  name: requiredText(200),
  category: assetCategorySchema,
  assetType: text(200),
  owner: text(200),
  location: text(200),
  treatment: text(4000),
  outOfScopeJustification: text(4000),
};

const JUSTIFICATION_REQUIRED = 'An out-of-scope asset needs a justification';

/**
 * `POST /api/ssp/assets`. The optional texts default to null. An `out_of_scope` asset needs a
 * non-blank justification; another category may keep one.
 */
export const createAssetRequestSchema = z
  .strictObject({
    name: assetFields.name,
    category: assetFields.category,
    assetType: assetFields.assetType.default(null),
    owner: assetFields.owner.default(null),
    location: assetFields.location.default(null),
    treatment: assetFields.treatment.default(null),
    outOfScopeJustification: assetFields.outOfScopeJustification.default(null),
  })
  .superRefine((body, ctx) => {
    if (body.category === 'out_of_scope' && body.outOfScopeJustification === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['outOfScopeJustification'],
        message: JUSTIFICATION_REQUIRED,
      });
    }
  });
export type CreateAssetRequest = z.infer<typeof createAssetRequestSchema>;

/**
 * `PATCH /api/ssp/assets/:id`: at least one key. The out-of-scope rule needs the stored row, so
 * the api checks it on the merged result.
 */
export const patchAssetRequestSchema = z
  .strictObject({
    name: assetFields.name.optional(),
    category: assetFields.category.optional(),
    assetType: assetFields.assetType.optional(),
    owner: assetFields.owner.optional(),
    location: assetFields.location.optional(),
    treatment: assetFields.treatment.optional(),
    outOfScopeJustification: assetFields.outOfScopeJustification.optional(),
  })
  .refine(SOMETHING_TO_CHANGE.check, { message: SOMETHING_TO_CHANGE.message });
export type PatchAssetRequest = z.infer<typeof patchAssetRequestSchema>;

/** `GET /api/ssp/assets`: category order, then name (case-insensitive), `createdAt`, `id`. */
export const assetsResponseSchema = z.object({ assets: z.array(assetSchema) });
export type AssetsResponse = z.infer<typeof assetsResponseSchema>;

export const assetResponseSchema = z.object({ asset: assetSchema });
export type AssetResponse = z.infer<typeof assetResponseSchema>;

// ---------------------------------------------------------------------------------------------
// External service providers.

export const providerTypeSchema = z.enum(PROVIDER_TYPES);

export const serviceProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerType: providerTypeSchema,
  /** Free text, such as "FedRAMP Moderate". */
  fedrampStatus: nullableString,
  services: nullableString,
  agreementReference: nullableString,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type ServiceProvider = z.infer<typeof serviceProviderSchema>;

const providerFields = {
  name: requiredText(200),
  providerType: providerTypeSchema,
  fedrampStatus: text(200),
  services: text(4000),
  agreementReference: text(1000),
};

/** `POST /api/ssp/providers`. The optional texts default to null. */
export const createServiceProviderRequestSchema = z.strictObject({
  name: providerFields.name,
  providerType: providerFields.providerType,
  fedrampStatus: providerFields.fedrampStatus.default(null),
  services: providerFields.services.default(null),
  agreementReference: providerFields.agreementReference.default(null),
});
export type CreateServiceProviderRequest = z.infer<typeof createServiceProviderRequestSchema>;

/** `PATCH /api/ssp/providers/:id`: at least one key. */
export const patchServiceProviderRequestSchema = z
  .strictObject({
    name: providerFields.name.optional(),
    providerType: providerFields.providerType.optional(),
    fedrampStatus: providerFields.fedrampStatus.optional(),
    services: providerFields.services.optional(),
    agreementReference: providerFields.agreementReference.optional(),
  })
  .refine(SOMETHING_TO_CHANGE.check, { message: SOMETHING_TO_CHANGE.message });
export type PatchServiceProviderRequest = z.infer<typeof patchServiceProviderRequestSchema>;

/** `GET /api/ssp/providers`: by name (case-insensitive), then `createdAt`, then `id`. */
export const providersResponseSchema = z.object({ providers: z.array(serviceProviderSchema) });
export type ProvidersResponse = z.infer<typeof providersResponseSchema>;

export const providerResponseSchema = z.object({ provider: serviceProviderSchema });
export type ProviderResponse = z.infer<typeof providerResponseSchema>;

// ---------------------------------------------------------------------------------------------
// The responsibility matrix: who carries out each requirement.

export const responsibilityPartySchema = z.enum(RESPONSIBILITY_PARTIES);

/** One requirement's row. A requirement with no stored row reads as all null. */
export const responsibilityRowSchema = z.object({
  requirementId: z.string(),
  party: responsibilityPartySchema.nullable(),
  provider: z.object({ id: z.string(), name: z.string() }).nullable(),
  note: nullableString,
  updatedAt: timestamp.nullable(),
});
export type ResponsibilityRow = z.infer<typeof responsibilityRowSchema>;

/** `GET /api/ssp/responsibilities`: one row per catalog requirement, in catalog order. */
export const responsibilityMatrixSchema = z.object({ rows: z.array(responsibilityRowSchema) });
export type ResponsibilityMatrix = z.infer<typeof responsibilityMatrixSchema>;

/** `PUT /api/ssp/responsibilities/:requirementId`. */
export const responsibilityRowResponseSchema = z.object({ row: responsibilityRowSchema });
export type ResponsibilityRowResponse = z.infer<typeof responsibilityRowResponseSchema>;

/**
 * `PUT /api/ssp/responsibilities/:requirementId`: every key is required. `esp` and `shared` name
 * a provider; `organization` and `null` never do.
 */
export const putResponsibilityRequestSchema = z
  .strictObject({
    party: responsibilityPartySchema.nullable(),
    providerId: z.uuid().nullable(),
    note: noteSchema,
  })
  .superRefine((body, ctx) => {
    const needsProvider = body.party === 'esp' || body.party === 'shared';
    if (needsProvider && body.providerId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerId'],
        message: 'An ESP or shared responsibility names its provider',
      });
    }
    if (!needsProvider && body.providerId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerId'],
        message: 'Only an ESP or shared responsibility names a provider',
      });
    }
  });
export type PutResponsibilityRequest = z.infer<typeof putResponsibilityRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Diagram links: an evidence item shown as a network or data-flow diagram.

export const diagramKindSchema = z.enum(DIAGRAM_KINDS);

/** The evidence version a link points at, file or reference. */
export const resolvedDiagramSchema = z.object({
  version: z.number().int().min(1),
  kind: z.enum(['file', 'reference']),
  fileName: nullableString,
  size: z.number().int().nullable(),
  sha256: nullableString,
  location: nullableString,
  createdAt: timestamp,
});
export type ResolvedDiagram = z.infer<typeof resolvedDiagramSchema>;

/**
 * A diagram link. `version` null follows the item's newest version; `resolved` is the version in
 * use, or null while the item has none. `embeddable`: resolved is a file, the item isn't flagged
 * "contains CUI", and `isEmbeddableImage(fileName)`.
 */
export const diagramLinkSchema = z.object({
  id: z.string(),
  kind: diagramKindSchema,
  caption: z.string(),
  evidence: z.object({ id: z.string(), title: z.string(), containsCui: z.boolean() }),
  version: z.number().int().nullable(),
  resolved: resolvedDiagramSchema.nullable(),
  embeddable: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type DiagramLink = z.infer<typeof diagramLinkSchema>;

const diagramFields = {
  kind: diagramKindSchema,
  caption: requiredText(200),
  /** A pinned version, or null for always the newest. */
  version: z.number().int().min(1).nullable(),
};

/** `POST /api/ssp/diagrams`. `version` is required: a number to pin, or null. */
export const createDiagramLinkRequestSchema = z.strictObject({
  evidenceId: z.uuid(),
  kind: diagramFields.kind,
  caption: diagramFields.caption,
  version: diagramFields.version,
});
export type CreateDiagramLinkRequest = z.infer<typeof createDiagramLinkRequestSchema>;

/** `PATCH /api/ssp/diagrams/:id`: at least one key. The evidence item can't change. */
export const patchDiagramLinkRequestSchema = z
  .strictObject({
    kind: diagramFields.kind.optional(),
    caption: diagramFields.caption.optional(),
    version: diagramFields.version.optional(),
  })
  .refine(SOMETHING_TO_CHANGE.check, { message: SOMETHING_TO_CHANGE.message });
export type PatchDiagramLinkRequest = z.infer<typeof patchDiagramLinkRequestSchema>;

/** `GET /api/ssp/diagrams`: kind order, then `createdAt`, then `id`. */
export const diagramsResponseSchema = z.object({ diagrams: z.array(diagramLinkSchema) });
export type DiagramsResponse = z.infer<typeof diagramsResponseSchema>;

export const diagramResponseSchema = z.object({ diagram: diagramLinkSchema });
export type DiagramResponse = z.infer<typeof diagramResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Document control: revision history, approvals and the review schedule.

/** One revision history entry. Append-only. */
export const sspRevisionSchema = z.object({
  id: z.string(),
  kind: z.enum(REVISION_KINDS),
  date: calendarDateSchema,
  description: z.string(),
  madeBy: z.string(),
  createdAt: timestamp,
});
export type SspRevision = z.infer<typeof sspRevisionSchema>;

/**
 * `POST /api/ssp/revisions`: a manual entry. `date` is today or earlier (the api checks it);
 * `madeBy` defaults to the actor's display name and, when sent, may not be blank.
 */
export const createRevisionRequestSchema = z.strictObject({
  date: calendarDateSchema,
  description: requiredText(2000),
  madeBy: requiredText(200).optional(),
});
export type CreateRevisionRequest = z.infer<typeof createRevisionRequestSchema>;

export const revisionResponseSchema = z.object({ revision: sspRevisionSchema });
export type RevisionResponse = z.infer<typeof revisionResponseSchema>;

/** One approval signature. A null `approvedOn` prints a blank signature line. */
export const sspApprovalSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  approvedOn: calendarDateSchema.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SspApproval = z.infer<typeof sspApprovalSchema>;

const approvalFields = {
  name: requiredText(200),
  title: requiredText(200),
  /** Today or earlier (the api checks it), or null. */
  approvedOn: calendarDateSchema.nullable(),
};

/** `POST /api/ssp/approvals` (admin). Every key is required; `approvedOn` may be null. */
export const createApprovalRequestSchema = z.strictObject({
  name: approvalFields.name,
  title: approvalFields.title,
  approvedOn: approvalFields.approvedOn,
});
export type CreateApprovalRequest = z.infer<typeof createApprovalRequestSchema>;

/** `PATCH /api/ssp/approvals/:id` (admin): at least one key. */
export const patchApprovalRequestSchema = z
  .strictObject({
    name: approvalFields.name.optional(),
    title: approvalFields.title.optional(),
    approvedOn: approvalFields.approvedOn.optional(),
  })
  .refine(SOMETHING_TO_CHANGE.check, { message: SOMETHING_TO_CHANGE.message });
export type PatchApprovalRequest = z.infer<typeof patchApprovalRequestSchema>;

export const approvalResponseSchema = z.object({ approval: sspApprovalSchema });
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;

/**
 * `GET /api/ssp/document-control`. `nextReviewDue` is the profile's `nextReviewDate` if set, else
 * the latest approval date plus the cadence, else null; `daysToReview` counts from the UTC today
 * and is negative once overdue.
 */
export const documentControlSchema = z.object({
  reviewCadenceMonths: z.number().int(),
  nextReviewDate: calendarDateSchema.nullable(),
  nextReviewDue: calendarDateSchema.nullable(),
  daysToReview: z.number().int().nullable(),
  reviewOverdue: z.boolean(),
  revisions: z.array(sspRevisionSchema),
  approvals: z.array(sspApprovalSchema),
});
export type DocumentControl = z.infer<typeof documentControlSchema>;
