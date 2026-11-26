import type { Catalog, RequirementId } from '@rampart/catalog';
import type { RequirementStatus } from '../types';
import { findFutureTenseTerms } from './future-tense';
import { SSP_LINT_RULES } from './rules';
import type {
  SspLintFinding,
  SspLintLimits,
  SspLintRule,
  SspLintRuleId,
  SspLintSources,
} from './types';

const MIB = 1024 * 1024;

type Outcome = SspLintSources['view']['evaluation']['outcomes'][number];
type State = SspLintSources['view']['requirementStates'][number];

/** What the rules know about one requirement, in catalog order. */
interface Row {
  id: RequirementId;
  prerequisite: boolean;
  status: RequirementStatus;
  allNa: boolean;
  naCount: number;
  statement: string | null | undefined;
  naRationale: string | null | undefined;
}

const isBlank = (text: string | null | undefined): boolean =>
  text === null || text === undefined || text.trim() === '';

/** Whole numbers plainly ("5"), others to one decimal ("2.5"). */
const mib = (bytes: number): string => {
  const value = bytes / MIB;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

const firstById = <T extends { requirementId: RequirementId }>(
  items: readonly T[],
): Map<RequirementId, T> => {
  const byId = new Map<RequirementId, T>();
  for (const item of items) if (!byId.has(item.requirementId)) byId.set(item.requirementId, item);
  return byId;
};

function rowsOf(catalog: Catalog, view: SspLintSources['view']): Row[] {
  const outcomes = firstById<Outcome>(view.evaluation.outcomes);
  const states = firstById<State>(view.requirementStates);
  return catalog.requirements.map((requirement) => {
    const outcome = outcomes.get(requirement.id);
    const state = states.get(requirement.id);
    return {
      id: requirement.id,
      prerequisite: requirement.scoring.kind === 'prerequisite',
      status: outcome?.status ?? 'not_assessed',
      allNa: outcome?.allNa ?? false,
      naCount: outcome?.counts.na ?? 0,
      statement: state?.implementationStatement,
      naRationale: state?.naRationale,
    };
  });
}

type Hit = { requirementId?: RequirementId; subjectId?: string; message: string };

/** Each rule's hits over the sources, in subject order. */
function hitsOf(
  rule: SspLintRuleId,
  rows: readonly Row[],
  sources: SspLintSources,
  limits: SspLintLimits,
  openPoam: ReadonlySet<RequirementId> | null,
): Hit[] {
  switch (rule) {
    case 'ssp_requirement_not_met':
      return rows
        .filter((r) => r.prerequisite && r.status !== 'met')
        .map((r) => ({
          requirementId: r.id,
          message: `${r.id} (the SSP requirement) is ${
            r.status === 'not_met' ? 'Not Met' : 'not yet assessed'
          }, so the assessment can't be completed.`,
        }));
    case 'no_assets':
      return sources.assets.length === 0 ? [{ message: 'No assets are recorded.' }] : [];
    case 'out_of_scope_unjustified':
      return sources.assets
        .filter((a) => a.category === 'out_of_scope' && isBlank(a.outOfScopeJustification))
        .map((a) => ({
          subjectId: a.id,
          message: `"${a.name}" is out of scope with no justification.`,
        }));
    case 'no_network_diagram':
      return sources.diagrams.some((d) => d.kind === 'network')
        ? []
        : [{ message: 'No network diagram is linked.' }];
    case 'review_overdue': {
      const { reviewOverdue, nextReviewDue, daysToReview } = sources.review;
      if (!reviewOverdue || nextReviewDue === null || daysToReview === null) return [];
      const days = -daysToReview;
      return [
        {
          message: `The SSP review was due ${nextReviewDue}, ${String(days)} ${days === 1 ? 'day' : 'days'} ago.`,
        },
      ];
    }
    case 'empty_statement':
      return rows
        .filter((r) => isBlank(r.statement) && !r.allNa)
        .map((r) => ({ requirementId: r.id, message: `${r.id} has no implementation statement.` }));
    case 'not_met_without_poam':
      if (openPoam === null) return [];
      return rows
        .filter((r) => r.status === 'not_met' && !r.prerequisite && !openPoam.has(r.id))
        .map((r) => ({
          requirementId: r.id,
          message: `${r.id} is Not Met and has no open POA&M item.`,
        }));
    case 'na_without_rationale':
      return rows
        .filter((r) => r.naCount >= 1 && isBlank(r.naRationale))
        .map((r) => ({
          requirementId: r.id,
          message: `${r.id} has objectives marked N/A and no N/A rationale.`,
        }));
    case 'future_tense':
      return rows.flatMap((r) => {
        const terms = findFutureTenseTerms(r.statement);
        if (terms.length === 0) return [];
        const quoted = terms.map((t) => `"${t}"`).join(', ');
        return [{ requirementId: r.id, message: `${r.id} says ${quoted} (future tense).` }];
      });
    case 'ssp_poam_mismatch':
      if (openPoam === null) return [];
      return rows
        .filter((r) => openPoam.has(r.id) && r.status !== 'not_met')
        .map((r) => {
          const word = r.allNa
            ? 'not applicable'
            : r.status === 'not_assessed'
              ? 'not yet assessed'
              : 'Met';
          return { requirementId: r.id, message: `${r.id} has an open POA&M item but is ${word}.` };
        });
    case 'large_image':
      return sources.diagrams.flatMap((d) => {
        const size = d.resolved?.size ?? null;
        if (!d.embeddable || size === null || size <= limits.largeImageBytes) return [];
        return [
          {
            subjectId: d.id,
            message: `"${d.caption}" is ${(size / MIB).toFixed(1)} MiB; images over ${mib(
              limits.largeImageBytes,
            )} MiB make the .docx large.`,
          },
        ];
      });
    case 'image_limit':
      return sources.diagrams
        .filter((d) => d.embeddable)
        .slice(limits.maxEmbeddedImages)
        .map((d) => ({
          subjectId: d.id,
          message: `"${d.caption}" is referenced, not embedded: the SSP embeds at most ${String(limits.maxEmbeddedImages)} images.`,
        }));
  }
}

const toFinding = (rule: SspLintRule, hit: Hit): SspLintFinding => ({
  rule: rule.id,
  severity: rule.severity,
  requirementId: hit.requirementId ?? null,
  subjectId: hit.subjectId ?? null,
  message: hit.message,
  hint: rule.hint,
});

/**
 * The SSP's pre-export findings, in `SSP_LINT_RULES` order and then subject order: catalog order
 * for requirements, input order for assets and diagrams. Pure: the input is never mutated.
 *
 * A requirement with no outcome is not assessed with no N/A objectives; a blank text (null, empty
 * or whitespace) counts as missing. Without `openPoamRequirementIds` the two POA&M rules are
 * skipped; IDs not in the catalog are ignored and duplicates count once.
 */
export function lintSspFrom(
  catalog: Catalog,
  sources: SspLintSources,
  limits: SspLintLimits,
): SspLintFinding[] {
  const rows = rowsOf(catalog, sources.view);
  const ids = sources.view.openPoamRequirementIds;
  const openPoam = ids === undefined ? null : new Set(ids);
  return SSP_LINT_RULES.flatMap((rule) =>
    hitsOf(rule.id, rows, sources, limits, openPoam).map((hit) => toFinding(rule, hit)),
  );
}
