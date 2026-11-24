import { catalogSchema } from './schema';
import type { Catalog } from './types';

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
