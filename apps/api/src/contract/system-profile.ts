// The system profile: the SSP's system characteristics, one per assessment.
import { z } from 'zod';
import { emailSchema, userRefSchema } from './common';

/** The profile's fields, in the order the SSP and the form show them. */
export const SYSTEM_PROFILE_FIELDS = [
  { key: 'systemName', label: 'System name' },
  { key: 'systemIdentifier', label: 'System identifier' },
  { key: 'organizationName', label: 'Organization' },
  { key: 'cageCode', label: 'CAGE code' },
  { key: 'description', label: 'System description' },
  { key: 'authorizationBoundary', label: 'Authorization boundary' },
  { key: 'environment', label: 'Operating environment' },
  { key: 'interconnections', label: 'Interconnections with other systems' },
  { key: 'informationTypes', label: 'Information types handled' },
  { key: 'systemOwner', label: 'System owner' },
  { key: 'systemOwnerEmail', label: 'System owner email' },
  { key: 'securityContact', label: 'Security contact' },
  { key: 'securityContactEmail', label: 'Security contact email' },
] as const satisfies readonly { key: string; label: string }[];

export type SystemProfileFieldKey = (typeof SYSTEM_PROFILE_FIELDS)[number]['key'];

/** Trims; empty or whitespace-only becomes null, and anything else must pass `value`. */
function blankToNull<T extends z.ZodType<string | null, string>>(value: T) {
  return z
    .string()
    .trim()
    .transform((text) => (text === '' ? null : text))
    .pipe(z.union([z.null(), value]))
    .nullable();
}

const text = (max: number) => blankToNull(z.string().max(max));

/** A CAGE code: exactly five of A–Z and 0–9, after trimming and uppercasing. */
const cageCodeSchema = blankToNull(
  z
    .string()
    .toUpperCase()
    .regex(/^[A-Z0-9]{5}$/, { message: 'A CAGE code is exactly 5 letters or digits' }),
);

const email = blankToNull(emailSchema);

/** The request-side rule for each field. */
const FIELD_RULES = {
  systemName: text(200),
  systemIdentifier: text(100),
  organizationName: text(200),
  cageCode: cageCodeSchema,
  description: text(20000),
  authorizationBoundary: text(20000),
  environment: text(20000),
  interconnections: text(20000),
  informationTypes: text(20000),
  systemOwner: text(200),
  systemOwnerEmail: email,
  securityContact: text(200),
  securityContactEmail: email,
} satisfies Record<SystemProfileFieldKey, z.ZodType>;

const nullableString = z.string().nullable();

/** The saved profile. Every field is null until set; `updatedAt`/`updatedBy` until the first save. */
export const systemProfileSchema = z.object({
  systemName: nullableString,
  systemIdentifier: nullableString,
  organizationName: nullableString,
  cageCode: nullableString,
  description: nullableString,
  authorizationBoundary: nullableString,
  environment: nullableString,
  interconnections: nullableString,
  informationTypes: nullableString,
  systemOwner: nullableString,
  systemOwnerEmail: nullableString,
  securityContact: nullableString,
  securityContactEmail: nullableString,
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: userRefSchema.nullable(),
});
export type SystemProfile = z.infer<typeof systemProfileSchema>;

/** `GET` and `PATCH /api/system-profile`. */
export const systemProfileResponseSchema = z.object({ profile: systemProfileSchema });
export type SystemProfileResponse = z.infer<typeof systemProfileResponseSchema>;

/** `PATCH /api/system-profile`: any of the fields, at least one; `null` or blank clears one. */
export const patchSystemProfileRequestSchema = z
  .strictObject({
    systemName: FIELD_RULES.systemName.optional(),
    systemIdentifier: FIELD_RULES.systemIdentifier.optional(),
    organizationName: FIELD_RULES.organizationName.optional(),
    cageCode: FIELD_RULES.cageCode.optional(),
    description: FIELD_RULES.description.optional(),
    authorizationBoundary: FIELD_RULES.authorizationBoundary.optional(),
    environment: FIELD_RULES.environment.optional(),
    interconnections: FIELD_RULES.interconnections.optional(),
    informationTypes: FIELD_RULES.informationTypes.optional(),
    systemOwner: FIELD_RULES.systemOwner.optional(),
    systemOwnerEmail: FIELD_RULES.systemOwnerEmail.optional(),
    securityContact: FIELD_RULES.securityContact.optional(),
    securityContactEmail: FIELD_RULES.securityContactEmail.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchSystemProfileRequest = z.infer<typeof patchSystemProfileRequestSchema>;
