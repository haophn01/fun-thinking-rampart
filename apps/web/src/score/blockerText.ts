import { getRequirement, type Catalog } from '@rampart/catalog';
import type { Blocker, IneligibleCode } from '@rampart/rules';

const INELIGIBLE: Record<IneligibleCode, string> = {
  not_not_met: 'it is not marked Not Met, so it has no POA&M to open',
  barred: 'it can never be put on a POA&M',
  exceeds_point_limit: 'its point value is over the POA&M limit',
};

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

/** A plain sentence for one Conditional blocker. The citation is shown separately. */
export function blockerText(blocker: Blocker, catalog: Catalog): string {
  switch (blocker.code) {
    case 'prerequisite_not_met': {
      const known = getRequirement(catalog, blocker.requirementId) !== undefined;
      return known
        ? `${blocker.requirementId} must be Met before a score exists`
        : `${blocker.requirementId} must be Met`;
    }
    case 'not_assessed':
      return `${plural(blocker.requirementIds.length, 'requirement')} not yet assessed`;
    case 'below_threshold':
      return `Score ${String(blocker.score)} is below the Conditional minimum of ${String(blocker.threshold)}`;
    case 'poam_ineligible':
      return `${blocker.requirementId} cannot go on a POA&M: ${blocker.reasons
        .map((reason) => INELIGIBLE[reason])
        .join('; ')}`;
    case 'poam_missing':
      return `${blocker.requirementId} is Not Met and has no open POA&M item`;
  }
}
