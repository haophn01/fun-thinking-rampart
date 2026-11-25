import catalogJson from '../data/nist-800-171-r2.json';
import { parseCatalog } from './schema';
import type { Catalog, Requirement, RequirementId } from './types';

let cached: Catalog | undefined;

/** The NIST SP 800-171 Rev. 2 catalog, validated on first use and cached after. */
export function loadCatalog(): Catalog {
  cached ??= parseCatalog(catalogJson);
  return cached;
}

/** What an assessment records as `catalog_version`: "nist-800-171-r2@1.0.0". */
export function catalogKey(catalog: Catalog): string {
  return `${catalog.id}@${catalog.version}`;
}

/** The requirement with exactly this CMMC id ("AC.L2-3.1.1"), or undefined. */
export function getRequirement(catalog: Catalog, id: RequirementId): Requirement | undefined {
  return catalog.requirements.find((r) => r.id === id);
}
