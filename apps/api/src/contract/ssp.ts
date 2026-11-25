// What the SSP export and the pages that show its terms share. S3 builds the document.
import type { z } from 'zod';
import type { objectiveStatusSchema, requirementStatusSchema } from './common';
import type { conditionalResultSchema } from './evaluation';

/** The `.docx` media type `GET /api/ssp/export` answers with. */
export const SSP_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The longest system identifier a file name keeps. */
const MAX_FILE_ID = 64;

/**
 * `SSP-<id>-<today>.docx`. The ID keeps `[A-Za-z0-9._-]`, turns each run of anything else into one
 * `-`, trims `-` from both ends and keeps at most 64 characters (trimming again if the cut lands
 * on a `-`). `null`, or nothing left after cleaning, gives `system`.
 */
export function sspFileName(systemIdentifier: string | null, today: string): string {
  const trimDashes = (value: string) => value.replace(/^-+|-+$/g, '');
  const cleaned = trimDashes(
    trimDashes((systemIdentifier ?? '').replace(/[^A-Za-z0-9._-]+/g, '-')).slice(0, MAX_FILE_ID),
  );
  return `SSP-${cleaned === '' ? 'system' : cleaned}-${today}.docx`;
}

type RequirementStatus = z.infer<typeof requirementStatusSchema>;
type ObjectiveStatus = z.infer<typeof objectiveStatusSchema>;
type ConditionalStatus = z.infer<typeof conditionalResultSchema>['status'];

export const REQUIREMENT_STATUS_LABELS = {
  met: 'Met',
  not_met: 'Not Met',
  not_assessed: 'Not Assessed',
} as const satisfies Record<RequirementStatus, string>;

/** What a requirement whose objectives are all N/A reads as, whatever its status. */
export const REQUIREMENT_NOT_APPLICABLE_LABEL = 'Not Applicable';

export const OBJECTIVE_STATUS_LABELS = {
  met: 'Met',
  not_met: 'Not Met',
  na: 'N/A',
  not_assessed: 'Not Assessed',
} as const satisfies Record<ObjectiveStatus, string>;

/** The Conditional check's status, as the score panel shows it. */
export const CONDITIONAL_STATUS_LABELS = {
  final: 'Final status reachable',
  conditional: 'Conditional status reachable',
  not_eligible: 'Not eligible',
  incomplete: 'Assessment incomplete',
} as const satisfies Record<ConditionalStatus, string>;
