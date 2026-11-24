import type { Catalog, FamilyCode } from '@rampart/catalog';
import type { Evaluation } from '@rampart/rules';
import { Link } from 'react-router';
import { GraduatedBar } from '../../look';
import styles from './assessment.module.css';

interface Counts {
  met: number;
  notMet: number;
  notAssessed: number;
}

function countsFor(catalog: Catalog, evaluation: Evaluation, family: FamilyCode): Counts {
  const ids = new Set(catalog.families.find((f) => f.code === family)?.requirementIds);
  const counts: Counts = { met: 0, notMet: 0, notAssessed: 0 };
  for (const outcome of evaluation.outcomes) {
    if (!ids.has(outcome.requirementId)) continue;
    if (outcome.status === 'met') counts.met += 1;
    else if (outcome.status === 'not_met') counts.notMet += 1;
    else counts.notAssessed += 1;
  }
  return counts;
}

export interface FamilyListProps {
  catalog: Catalog;
  evaluation: Evaluation;
  selected: FamilyCode;
}

/** Every family: code, name, requirement counts and a bar of how much is assessed. */
export function FamilyList({ catalog, evaluation, selected }: FamilyListProps) {
  return (
    <nav aria-label="Families" className={styles.families}>
      <ul className={styles.list}>
        {catalog.families.map((family) => {
          const counts = countsFor(catalog, evaluation, family.code);
          const total = counts.met + counts.notMet + counts.notAssessed;
          const percent =
            total === 0 ? 0 : Math.round(((total - counts.notAssessed) / total) * 100);
          return (
            <li key={family.code}>
              <Link
                to={{ search: `?family=${family.code}` }}
                className={styles.item}
                aria-current={family.code === selected ? 'true' : undefined}
                data-family={family.code}
              >
                <span className={styles.itemHead}>
                  <span className={styles.code}>{family.code}</span>
                  <span>{family.name}</span>
                </span>
                <span className={styles.counts}>
                  <span>Met {counts.met}</span>
                  <span>Not Met {counts.notMet}</span>
                  <span>Not Assessed {counts.notAssessed}</span>
                </span>
                <GraduatedBar value={percent} label={`${family.code} percent assessed`} />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
