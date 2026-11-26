// Section 4, the record of changes, and the approvals' signature lines.
import { field, heading, paragraph } from './common';
import { SSP_SECTIONS } from './sections';
import type { SspBlock, SspSource } from './types';

function cadence(months: number): string {
  return `every ${String(months)} ${months === 1 ? 'month' : 'months'}`;
}

export function changesBlocks(source: SspSource): SspBlock[] {
  const control = source.documentControl;
  const rows = control.revisions.map((r) => [r.date, r.description, r.madeBy]);
  if (source.exportEntry !== null) {
    const { date, description, madeBy } = source.exportEntry;
    rows.push([date, description, madeBy]);
  }
  return [
    heading(1, SSP_SECTIONS.changes),
    field('Review cadence', cadence(control.reviewCadenceMonths)),
    field('Next review due', control.nextReviewDue ?? 'Not set'),
    rows.length === 0
      ? paragraph('No changes recorded.')
      : { kind: 'table', columns: ['Date', 'Description', 'Made by'], rows },
  ];
}

export function approvalBlocks(source: SspSource): SspBlock[] {
  const { approvals } = source.documentControl;
  return [
    heading(1, SSP_SECTIONS.approvals),
    ...(approvals.length === 0
      ? [paragraph('No approvals recorded.')]
      : approvals.map((a): SspBlock => ({
          kind: 'signature',
          name: a.name,
          title: a.title,
          date: a.approvedOn,
        }))),
  ];
}
