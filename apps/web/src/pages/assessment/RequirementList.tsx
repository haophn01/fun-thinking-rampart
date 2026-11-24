import type { Catalog, FamilyCode, RequirementId } from '@rampart/catalog';
import type { Evaluation } from '@rampart/rules';
import { Link } from 'react-router';
import { StatusChip } from '../../look';
import styles from './assessment.module.css';

export interface RequirementListProps {
  catalog: Catalog;
  family: FamilyCode;
  evaluation: Evaluation;
  selected: RequirementId | null;
  ownerOf: (requirementId: RequirementId) => string | null;
  /** Requirements whose status differs under the what-if. */
  whatIfChanged: ReadonlySet<RequirementId>;
}

/** A family's requirements in catalog order: ID, derived status and owner. */
export function RequirementList({
  catalog,
  family,
  evaluation,
  selected,
  ownerOf,
  whatIfChanged,
}: RequirementListProps) {
  const statuses = new Map(evaluation.outcomes.map((o) => [o.requirementId, o.status]));
  const ids = catalog.families.find((f) => f.code === family)?.requirementIds ?? [];
  return (
    <nav aria-label="Requirements" className={styles.requirements}>
      <ul className={styles.list}>
        {ids.map((id) => {
          const owner = ownerOf(id);
          return (
            <li key={id}>
              <Link
                to={{ search: `?family=${family}&req=${encodeURIComponent(id)}` }}
                className={styles.item}
                aria-current={id === selected ? 'true' : undefined}
                data-requirement={id}
              >
                <span className={styles.code}>{id}</span>
                <span className={styles.itemMeta}>
                  <StatusChip status={statuses.get(id) ?? 'not_assessed'} />
                  {whatIfChanged.has(id) && <span className={styles.tag}>what-if</span>}
                </span>
                <span className={styles.owner}>{owner ?? 'Unassigned'}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
