import type { ObjectiveId, RequirementId } from '@rampart/catalog';

export type ObjectiveStatus = 'met' | 'not_met' | 'na' | 'not_assessed';
export type RequirementStatus = 'met' | 'not_met' | 'not_assessed';
export type ImplementationLevel = 'none' | 'partial';           // only for requirements with partialCredit
export type AssessmentType = 'self' | 'c3pao';
export interface ObjectiveResult { objectiveId: ObjectiveId; status: ObjectiveStatus }
export interface AssessmentInput { objectiveResults: readonly ObjectiveResult[];
  implementationLevels: Readonly<Partial<Record<RequirementId, ImplementationLevel>>> }
export interface RequirementOutcome { requirementId: RequirementId; status: RequirementStatus; allNa: boolean;
  counts: Record<ObjectiveStatus, number>; implementationLevel: ImplementationLevel | null; deduction: number }
export interface Deduction { requirementId: RequirementId; points: number }
export type ScoreResult =
  | { kind: 'scored'; score: number; max: number; floor: number; deductions: Deduction[]; notAssessed: RequirementId[] }
  | { kind: 'incomplete'; reason: 'prerequisite_not_met'; prerequisites: RequirementId[];
      max: number; floor: number; notAssessed: RequirementId[] };
export type IneligibleCode = 'not_not_met' | 'barred' | 'exceeds_point_limit';
export type EligibilityResult = { eligible: true }
  | { eligible: false; reasons: { code: IneligibleCode; citation: string }[] };
export type Blocker =
  | { code: 'prerequisite_not_met'; requirementId: RequirementId; citation: string }
  | { code: 'not_assessed'; requirementIds: RequirementId[] }
  | { code: 'below_threshold'; score: number; threshold: number; citation: string }
  | { code: 'poam_ineligible'; requirementId: RequirementId; reasons: IneligibleCode[]; citation: string };
export interface ConditionalResult { status: 'final' | 'conditional' | 'not_eligible' | 'incomplete'; blockers: Blocker[] }
export interface CloseoutClock { conditionalStatusDate: string; deadline: string; daysRemaining: number; expired: boolean }
export interface Cited<T> { value: T; citation: string }
export interface Regulation { id: 'cmmc-32-cfr-170'; version: string; sources: { title: string; url: string }[];
  conditionalMinScore: Cited<number>; poamNotMetOnly: Cited<boolean>; poamMaxItemPoints: Cited<number>;
  poamPointExceptions: { requirementId: RequirementId; implementationLevel: ImplementationLevel; maxPoints: number; citation: string }[];
  poamBarred: Cited<RequirementId[]>; closeoutWindowDays: Cited<number>;
  closeoutConfirmedBy: Cited<Record<AssessmentType, 'organization' | 'c3pao'>> }
