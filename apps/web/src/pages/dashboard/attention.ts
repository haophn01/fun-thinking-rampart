import type { AssessmentView, DocumentControl, PoamView } from '@rampart/api/contract';
import { getRequirement, type Catalog } from '@rampart/catalog';

export type AttentionKind =
  | 'prerequisite'
  | 'poam_ineligible'
  | 'poam_missing'
  | 'overdue'
  | 'due_after_deadline'
  | 'ready_to_close'
  | 'not_assessed'
  | 'review_overdue';

export interface AttentionRow {
  key: string;
  kind: AttentionKind;
  /** Where the fix lives: the assessment, the POA&M page or the SSP's Document control tab. */
  href: '/assessment' | '/poam' | '/ssp?tab=document-control';
  /** What is wrong, in a plain phrase. */
  message: string;
  /** Present on requirement rows; absent on the "not yet assessed" summary row. */
  requirementId?: string;
  chip?: 'met' | 'not_met' | 'not_assessed';
  text?: string;
  /** The requirement's SPRS points; null for the prerequisite. */
  points?: number | null;
  owner?: string | null;
}

type Item = PoamView['items'][number];

/**
 * What the dashboard asks a person to look at, in this order: the SSP prerequisite, each
 * SSP review overdue (when `control` says so), each ineligible requirement, each Not Met requirement without an open POA&M item, overdue open
 * items, open items due after the closeout deadline, open items ready to close, then the count
 * of requirements not yet assessed. Closed items never appear. Empty means nothing to do.
 */
export function needsAttention(
  view: AssessmentView,
  poam: PoamView,
  catalog: Catalog,
  control?: DocumentControl | null,
): AttentionRow[] {
  const { blockers } = view.evaluation.conditional;
  const outcomeOf = new Map(view.evaluation.outcomes.map((o) => [o.requirementId, o.status]));
  const ownerOf = new Map(view.requirementStates.map((s) => [s.requirementId, s.owner]));

  const requirementRow = (
    kind: AttentionKind,
    href: AttentionRow['href'],
    requirementId: string,
    message: string,
    key: string,
    owner: string | null | undefined,
  ): AttentionRow => {
    const requirement = getRequirement(catalog, requirementId);
    return {
      key,
      kind,
      href,
      message,
      requirementId,
      chip: outcomeOf.get(requirementId) ?? 'not_assessed',
      text: requirement?.text ?? '',
      points: requirement?.scoring.kind === 'points' ? requirement.scoring.points : null,
      owner: owner ?? ownerOf.get(requirementId)?.displayName ?? null,
    };
  };

  const rows: AttentionRow[] = [];

  for (const b of blockers) {
    if (b.code === 'prerequisite_not_met') {
      rows.push(
        requirementRow(
          'prerequisite',
          '/assessment',
          b.requirementId,
          'Must be Met before a score exists',
          `prerequisite-${b.requirementId}`,
          undefined,
        ),
      );
    }
  }
  if (
    control?.reviewOverdue === true &&
    control.nextReviewDue !== null &&
    control.daysToReview !== null
  ) {
    const late = Math.abs(control.daysToReview);
    rows.push({
      key: 'review-overdue',
      kind: 'review_overdue',
      href: '/ssp?tab=document-control',
      message: `SSP review overdue: due ${control.nextReviewDue} · ${String(late)} ${late === 1 ? 'day' : 'days'} overdue`,
    });
  }
  for (const b of blockers) {
    if (b.code === 'poam_ineligible') {
      rows.push(
        requirementRow(
          'poam_ineligible',
          '/assessment',
          b.requirementId,
          'Cannot go on a POA&M',
          `ineligible-${b.requirementId}`,
          undefined,
        ),
      );
    }
  }
  for (const b of blockers) {
    if (b.code === 'poam_missing') {
      rows.push(
        requirementRow(
          'poam_missing',
          '/poam',
          b.requirementId,
          'Not Met with no open POA&M item',
          `missing-${b.requirementId}`,
          undefined,
        ),
      );
    }
  }

  const open: Item[] = poam.items.filter((item) => item.status === 'open');
  const itemRows = (
    kind: AttentionKind,
    pick: (item: Item) => boolean,
    message: (item: Item) => string,
  ) => {
    for (const item of open.filter(pick)) {
      rows.push({
        ...requirementRow(
          kind,
          '/poam',
          item.requirementId,
          message(item),
          `${kind}-${item.id}`,
          item.owner?.displayName ?? null,
        ),
        chip: item.requirementStatus,
      });
    }
  };
  itemRows(
    'overdue',
    (i) => i.overdue,
    (i) => `POA&M overdue: due ${i.due}`,
  );
  itemRows(
    'due_after_deadline',
    (i) => i.dueAfterDeadline,
    (i) => `POA&M due ${i.due}, after the closeout deadline`,
  );
  itemRows(
    'ready_to_close',
    (i) => i.readyToClose,
    () => 'POA&M ready to close: the requirement is Met',
  );

  for (const b of blockers) {
    if (b.code === 'not_assessed') {
      const n = b.requirementIds.length;
      rows.push({
        key: 'not-assessed',
        kind: 'not_assessed',
        href: '/assessment',
        message: `${String(n)} ${n === 1 ? 'requirement' : 'requirements'} not yet assessed`,
      });
    }
  }
  return rows;
}
