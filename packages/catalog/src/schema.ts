import { z } from 'zod';
import type { Catalog, FamilyCode } from './types';

/** NIST section of each family, in catalog order (SP 800-171 Rev. 2, chapter three). */
export const FAMILY_SECTIONS = {
  AC: '3.1',
  AT: '3.2',
  AU: '3.3',
  CM: '3.4',
  IA: '3.5',
  IR: '3.6',
  MA: '3.7',
  MP: '3.8',
  PS: '3.9',
  PE: '3.10',
  RA: '3.11',
  CA: '3.12',
  SC: '3.13',
  SI: '3.14',
} as const satisfies Record<FamilyCode, string>;

export const FAMILY_CODES = Object.keys(FAMILY_SECTIONS) as FamilyCode[];

/** Numeric order of dotted NIST ids, so 3.1.9 sorts before 3.1.10. */
export function compareNistIds(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? -1) - (right[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The section a NIST requirement id belongs to: "3.1.10" → "3.1". */
export function sectionOf(nistId: string): string {
  return nistId.split('.').slice(0, 2).join('.');
}

const familyCode = z.enum(FAMILY_CODES as [FamilyCode, ...FamilyCode[]]);
const citation = z.string().min(1);
const text = z.string().min(1);

const scoring = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('points'),
    points: z.union([z.literal(1), z.literal(3), z.literal(5)]),
    citation,
    partialCredit: z.object({ deduction: z.literal(3), label: text, citation }).nullable(),
  }),
  z.object({ kind: z.literal('prerequisite'), citation }),
]);

const requirement = z.object({
  id: z.string().regex(/^[A-Z]{2}\.L2-3\.\d+\.\d+$/),
  nistId: z.string().regex(/^3\.\d+\.\d+$/),
  family: familyCode,
  type: z.enum(['basic', 'derived']),
  text,
  scoring,
  objectives: z.array(z.object({ id: z.string().regex(/^3\.\d+\.\d+\[[a-z]+\]$/), text })),
});

const catalogShape = z.object({
  id: z.literal('nist-800-171-r2'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sources: z
    .array(
      z.object({
        title: text,
        url: z.url(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        retrieved: z.iso.date(),
      }),
    )
    .min(1),
  families: z.array(
    z.object({
      code: familyCode,
      nistSection: z.string().regex(/^3\.\d+$/),
      name: text,
      requirementIds: z.array(z.string()),
    }),
  ),
  requirements: z.array(requirement),
});

export const catalogSchema: z.ZodType<Catalog> = catalogShape.superRefine((catalog, ctx) => {
  const fail = (message: string) => {
    ctx.addIssue({ code: 'custom', message });
  };

  const seenRequirements = new Set<string>();
  const seenObjectives = new Set<string>();
  let previous: string | undefined;
  for (const r of catalog.requirements) {
    if (seenRequirements.has(r.id)) fail(`duplicate requirement ${r.id}`);
    seenRequirements.add(r.id);

    const expectedId = `${r.family}.L2-${r.nistId}`;
    if (r.id !== expectedId) fail(`requirement ${r.id} should be ${expectedId}`);
    if (sectionOf(r.nistId) !== FAMILY_SECTIONS[r.family]) {
      fail(`requirement ${r.id}: ${r.nistId} is not in section ${FAMILY_SECTIONS[r.family]}`);
    }
    if (previous !== undefined && compareNistIds(previous, r.nistId) >= 0) {
      fail(`requirement ${r.id} is out of numeric order after ${previous}`);
    }
    previous = r.nistId;

    if (r.objectives.length === 0) fail(`requirement ${r.id} has no objectives`);
    for (const o of r.objectives) {
      if (!o.id.startsWith(`${r.nistId}[`)) fail(`objective ${o.id} is not under ${r.id}`);
      if (seenObjectives.has(o.id)) fail(`duplicate objective ${o.id}`);
      seenObjectives.add(o.id);
    }
  }

  const listed = new Set<string>();
  for (const f of catalog.families) {
    if (f.nistSection !== FAMILY_SECTIONS[f.code]) {
      fail(`family ${f.code} should be section ${FAMILY_SECTIONS[f.code]}`);
    }
    const actual = catalog.requirements.filter((r) => r.family === f.code).map((r) => r.id);
    if (actual.join() !== f.requirementIds.join()) {
      fail(
        `family ${f.code} lists [${f.requirementIds.join(', ')}] but its requirements are [${actual.join(', ')}]`,
      );
    }
    f.requirementIds.forEach((id) => listed.add(id));
  }
  for (const r of catalog.requirements) {
    if (!listed.has(r.id)) fail(`requirement ${r.id} is in no family list`);
  }
  const familyOrder = catalog.families.map((f) => f.code).join();
  const expectedOrder = FAMILY_CODES.filter((c) =>
    catalog.families.some((f) => f.code === c),
  ).join();
  if (
    familyOrder !== expectedOrder ||
    new Set(familyOrder.split(',')).size !== catalog.families.length
  ) {
    fail(`families must appear once each, in NIST order: got ${familyOrder}`);
  }
});

/** Validates catalog JSON against the schema; throws an Error naming every problem. */
export function parseCatalog(json: unknown): Catalog {
  const result = catalogSchema.safeParse(json);
  if (!result.success) {
    const problems = result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    );
    throw new Error(`invalid catalog: ${problems.join('; ')}`);
  }
  return result.data;
}

/**
 * Normalizes a CMMC practice id as printed in 32 CFR 170.24 to the catalog form:
 * stray spaces are removed and "IA-L2-3.5.1" becomes "IA.L2-3.5.1".
 */
export function normalizePracticeId(raw: string): string {
  const match = /^([A-Z]{2})[.-]L2-(3\.\d+\.\d+)$/.exec(raw.replace(/\s+/g, ''));
  if (!match?.[1] || !match[2]) throw new Error(`not a CMMC Level 2 practice id: ${raw}`);
  return `${match[1]}.L2-${match[2]}`;
}
