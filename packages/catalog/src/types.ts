export type FamilyCode = 'AC'|'AT'|'AU'|'CM'|'IA'|'IR'|'MA'|'MP'|'PS'|'PE'|'RA'|'CA'|'SC'|'SI';
export type RequirementId = string;   // CMMC form "AC.L2-3.1.1"
export type ObjectiveId = string;     // "3.1.1[a]" (nistId + bracketed letter), unique catalog-wide
export interface CatalogSource { title: string; url: string; sha256: string; retrieved: string } // retrieved: YYYY-MM-DD
export interface Objective { id: ObjectiveId; text: string }
export type Scoring =
  | { kind: 'points'; points: 1 | 3 | 5; citation: string;
      partialCredit: null | { deduction: 3; label: string; citation: string } }
  | { kind: 'prerequisite'; citation: string };   // CA.L2-3.12.4 only
export interface Requirement { id: RequirementId; nistId: string; family: FamilyCode;
  type: 'basic' | 'derived'; text: string; scoring: Scoring; objectives: Objective[] }
export interface Family { code: FamilyCode; nistSection: string; name: string; requirementIds: RequirementId[] }
export interface Catalog { id: 'nist-800-171-r2'; version: string; sources: CatalogSource[];
  families: Family[]; requirements: Requirement[] }
