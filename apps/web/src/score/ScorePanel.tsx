import { loadCatalog, type Catalog } from '@rampart/catalog';
import type { Evaluation, EvaluationDiff } from '@rampart/rules';
import { Alert } from '../look';
import { blockerText } from './blockerText';
import styles from './ScorePanel.module.css';

const STATUS_LABEL: Record<Evaluation['conditional']['status'], string> = {
  final: 'Final status reachable',
  conditional: 'Conditional status reachable',
  not_eligible: 'Not eligible',
  incomplete: 'Assessment incomplete',
};

const SSP_MESSAGE = 'System Security Plan must be Met before a score exists';

/** `+5`, `−3` (U+2212), `±0`, and `—` when there is no delta. */
export function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  if (delta === 0) return '±0';
  return delta > 0 ? `+${String(delta)}` : `−${String(Math.abs(delta))}`;
}

export interface ScorePanelProps {
  saved: Evaluation;
  /** When set, the panel shows this evaluation and the what-if notice. */
  whatIf?: Evaluation;
  diff?: EvaluationDiff;
  catalog?: Catalog;
}

/** The SPRS value, the Conditional status label and the blockers. */
export function ScorePanel({ saved, whatIf, diff, catalog = loadCatalog() }: ScorePanelProps) {
  const shown = whatIf ?? saved;
  const { score, conditional } = shown;
  const blockers =
    score.kind === 'incomplete'
      ? conditional.blockers.filter((b) => b.code !== 'prerequisite_not_met')
      : conditional.blockers;
  const changed = diff?.changed.length ?? 0;

  return (
    <section className={styles.panel} aria-label="SPRS score" data-status={conditional.status}>
      {whatIf !== undefined && (
        <Alert tone="info" title="What-if — not saved">
          <span>
            What-if score {score.kind === 'scored' ? String(score.score) : '—'}
            {' · '}Change {formatDelta(diff?.scoreDelta ?? null)}
            {' · '}
            {String(changed)} {changed === 1 ? 'requirement' : 'requirements'} changed
          </span>
        </Alert>
      )}
      <div className={styles.reading}>
        <span className={styles.value} data-testid="score-value">
          {score.kind === 'scored' ? score.score : '—'}
        </span>
        <span className={styles.max}>/ {score.max}</span>
      </div>
      <p className={styles.status}>{STATUS_LABEL[conditional.status]}</p>
      {score.kind === 'incomplete' && (
        <p className={styles.message}>
          {score.prerequisites[0] ?? 'CA.L2-3.12.4'} {SSP_MESSAGE}
        </p>
      )}
      {blockers.length > 0 && (
        <ul className={styles.blockers} aria-label="Blockers">
          {blockers.map((blocker, index) => (
            <li key={`${blocker.code}-${String(index)}`} className={styles.blocker}>
              <span>{blockerText(blocker, catalog)}</span>
              {'citation' in blocker && (
                <span className={styles.cite} data-cite="">
                  {blocker.citation}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
