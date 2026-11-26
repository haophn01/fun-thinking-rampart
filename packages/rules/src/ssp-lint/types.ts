import type { RequirementId } from '@rampart/catalog';
import type { ObjectiveStatus, RequirementStatus } from '../types';

export type SspLintRuleId =
  | 'ssp_requirement_not_met'
  | 'no_assets'
  | 'out_of_scope_unjustified'
  | 'no_network_diagram'
  | 'review_overdue'
  | 'empty_statement'
  | 'not_met_without_poam'
  | 'na_without_rationale'
  | 'future_tense'
  | 'ssp_poam_mismatch'
  | 'large_image'
  | 'image_limit';

export type SspLintSeverity = 'error' | 'warning';

export interface SspLintRule {
  id: SspLintRuleId;
  severity: SspLintSeverity;
  label: string;
  hint: string;
}

/** One finding. `subjectId` is the asset or diagram link id; `hint` is the rule's hint. */
export interface SspLintFinding {
  rule: SspLintRuleId;
  severity: SspLintSeverity;
  requirementId: RequirementId | null;
  subjectId: string | null;
  message: string;
  hint: string;
}

/**
 * What the lint reads. The shapes are structural, so the api contract's `AssessmentView`,
 * `Asset[]`, `DiagramLink[]` and `DocumentControl` fit without an import.
 */
export interface SspLintSources {
  view: {
    requirementStates: readonly {
      requirementId: RequirementId;
      implementationStatement: string | null;
      naRationale?: string | null | undefined;
    }[];
    /** Absent: the caller has no POA&M data, so the POA&M rules are skipped. */
    openPoamRequirementIds?: readonly RequirementId[] | undefined;
    evaluation: {
      outcomes: readonly {
        requirementId: RequirementId;
        status: RequirementStatus;
        allNa: boolean;
        counts: Readonly<Record<ObjectiveStatus, number>>;
      }[];
    };
  };
  assets: readonly {
    id: string;
    name: string;
    category: string;
    outOfScopeJustification: string | null;
  }[];
  diagrams: readonly {
    id: string;
    caption: string;
    kind: string;
    embeddable: boolean;
    resolved: { size: number | null } | null;
  }[];
  review: {
    reviewOverdue: boolean;
    nextReviewDue: string | null;
    daysToReview: number | null;
  };
}

export interface SspLintLimits {
  maxEmbeddedImages: number;
  largeImageBytes: number;
}
