// Appendix A, the assessment's status and POA&M, and Appendix B, every objective's result.
import { REGULATION } from '@rampart/rules/poam';
import {
  ASSESSMENT_TYPE_LABELS,
  CONDITIONAL_STATUS_LABELS,
  NIST_STATUSES,
  NIST_STATUS_LABELS,
  OBJECTIVE_STATUS_LABELS,
  type AssessmentView,
  type PoamView,
} from '../../src/contract';
import { familyHeading, field, heading, ownerName, paragraph } from './common';
import { byFamily, nistStatusOf } from './requirements';
import { SSP_SECTIONS } from './sections';
import type { SspBlock, SspSource } from './types';

function scoreLine(score: AssessmentView['evaluation']['score']): string {
  if (score.kind === 'scored') return `SPRS ${String(score.score)} / ${String(score.max)}`;
  return `SPRS incomplete: ${score.prerequisites.join(', ')} must be Met`;
}

function poamTable(poam: PoamView): SspBlock {
  if (poam.items.length === 0) return paragraph('No POA&M items recorded.');
  return {
    kind: 'table',
    columns: ['Requirement', 'Status', 'Due', 'Plan', 'Milestones', 'Owner', 'Closed on'],
    rows: poam.items.map((item) => [
      item.requirementId,
      item.status === 'open' ? 'Open' : 'Closed',
      item.due,
      item.plan,
      String(item.milestones.length),
      ownerName(item.owner),
      item.closeout?.closedOn ?? 'Not closed',
    ]),
  };
}

export function assessmentStatusBlocks(source: SspSource): SspBlock[] {
  const { assessment, evaluation, closeout } = source.view;
  const outcomes = new Map(evaluation.outcomes.map((o) => [o.requirementId, o]));
  const counts = new Map(NIST_STATUSES.map((s) => [s, 0]));
  for (const requirement of source.catalog.requirements) {
    const status = nistStatusOf(outcomes.get(requirement.id));
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const openItems = source.poam.items.filter((i) => i.status === 'open').length;
  return [
    heading(1, SSP_SECTIONS.assessmentStatus),
    field('Catalog version', assessment.catalogVersion),
    field('Regulation version', `${REGULATION.id}@${REGULATION.version}`),
    field('Assessment type', ASSESSMENT_TYPE_LABELS[assessment.type]),
    paragraph(scoreLine(evaluation.score)),
    field('Conditional status', CONDITIONAL_STATUS_LABELS[evaluation.conditional.status]),
    ...(closeout === null
      ? []
      : [
          field('Conditional Status Date', closeout.conditionalStatusDate),
          field('Closeout deadline', closeout.deadline),
        ]),
    {
      kind: 'table',
      columns: ['Implementation status', 'Requirements'],
      rows: NIST_STATUSES.map((s) => [NIST_STATUS_LABELS[s], String(counts.get(s) ?? 0)]),
    },
    field('Open POA&M items', String(openItems)),
    poamTable(source.poam),
  ];
}

export function objectivesBlocks(source: SspSource): SspBlock[] {
  const results = new Map(source.view.objectiveResults.map((r) => [r.objectiveId, r]));
  const families = byFamily(source.catalog.requirements);
  return [
    heading(1, SSP_SECTIONS.objectives),
    ...source.catalog.families.flatMap((family): SspBlock[] => [
      heading(2, familyHeading(family)),
      {
        kind: 'table',
        columns: ['ID', 'Objective', 'Status', 'Note'],
        rows: (families.get(family.code) ?? []).flatMap((r) =>
          r.objectives.map((o) => {
            const result = results.get(o.id);
            return [
              o.id,
              o.text,
              OBJECTIVE_STATUS_LABELS[result?.status ?? 'not_assessed'],
              result?.note ?? '',
            ];
          }),
        ),
      },
    ]),
  ];
}
