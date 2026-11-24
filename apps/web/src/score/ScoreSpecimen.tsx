import { loadCatalog } from '@rampart/catalog';
import { evaluateAssessment, type AssessmentInput, type ObjectiveStatus } from '@rampart/rules';
import { Button, RadioGroup, type RadioOption } from '../look';
import { ScorePanel } from './ScorePanel';
import styles from './ScorePanel.module.css';
import { useWhatIf } from './useWhatIf';

const catalog = loadCatalog();

function inputWith(statusFor: (requirementId: string) => ObjectiveStatus): AssessmentInput {
  return {
    objectiveResults: catalog.requirements.flatMap((r) =>
      r.objectives.map((o) => ({ objectiveId: o.id, status: statusFor(r.id) })),
    ),
    implementationLevels: {},
  };
}

const CONDITIONAL = inputWith((id) => (id === 'AC.L2-3.1.3' ? 'not_met' : 'met'));
const NOT_ELIGIBLE = inputWith((id) => (id === 'AC.L2-3.1.20' ? 'not_met' : 'met'));
const INCOMPLETE = inputWith((id) => (id === 'CA.L2-3.12.4' ? 'not_assessed' : 'met'));
const FINAL = inputWith(() => 'met');

const STATUS_OPTIONS: readonly RadioOption<ObjectiveStatus>[] = [
  { value: 'met', label: 'Met', status: 'met' },
  { value: 'not_met', label: 'Not Met', status: 'not_met' },
];

function WhatIfDemo() {
  const whatIf = useWhatIf(CONDITIONAL);
  const current = (id: string, objective: string): ObjectiveStatus =>
    whatIf.changes.objectiveStatuses?.[objective] ?? (id === 'AC.L2-3.1.3' ? 'not_met' : 'met');
  return (
    <div className={styles.specStack}>
      <div className={styles.specRow}>
        <Button onClick={whatIf.active ? whatIf.exit : whatIf.start}>
          {whatIf.active ? 'Exit what-if' : 'Try changes'}
        </Button>
        <Button variant="secondary" onClick={whatIf.reset} disabled={!whatIf.active}>
          Reset
        </Button>
      </div>
      {whatIf.active && (
        <>
          <RadioGroup
            legend="3.1.1[a] Authorized users"
            name="obj-311a"
            options={STATUS_OPTIONS}
            value={current('AC.L2-3.1.1', '3.1.1[a]')}
            onChange={(status) => {
              whatIf.setObjective('3.1.1[a]', status);
            }}
          />
          <RadioGroup
            legend="3.1.3[a] Control CUI flow"
            name="obj-313a"
            options={STATUS_OPTIONS}
            value={current('AC.L2-3.1.3', '3.1.3[a]')}
            onChange={(status) => {
              whatIf.setObjective('3.1.3[a]', status);
            }}
          />
        </>
      )}
      <ScorePanel
        saved={evaluateAssessment(catalog, CONDITIONAL)}
        {...(whatIf.active ? { whatIf: whatIf.evaluation, diff: whatIf.diff } : {})}
      />
    </div>
  );
}

/** Dev-only specimen of the score panel (/score.html). */
export function ScoreSpecimen() {
  return (
    <main className={styles.specPage}>
      <h1 className={styles.specTitle}>Score panel</h1>
      <section className={styles.specSection}>
        <h2 className={styles.specHead}>Saved: final</h2>
        <ScorePanel saved={evaluateAssessment(catalog, FINAL)} />
      </section>
      <section className={styles.specSection}>
        <h2 className={styles.specHead}>Saved: conditional</h2>
        <ScorePanel saved={evaluateAssessment(catalog, CONDITIONAL)} />
      </section>
      <section className={styles.specSection}>
        <h2 className={styles.specHead}>Saved: not eligible</h2>
        <ScorePanel saved={evaluateAssessment(catalog, NOT_ELIGIBLE)} />
      </section>
      <section className={styles.specSection}>
        <h2 className={styles.specHead}>Saved: incomplete</h2>
        <ScorePanel saved={evaluateAssessment(catalog, INCOMPLETE)} />
      </section>
      <section className={styles.specSection}>
        <h2 className={styles.specHead}>What-if (interactive)</h2>
        <WhatIfDemo />
      </section>
    </main>
  );
}
