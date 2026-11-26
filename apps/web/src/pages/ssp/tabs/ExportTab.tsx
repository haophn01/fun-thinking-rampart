import { assessmentViewSchema, type AssessmentView } from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, StatusChip } from '../../../look';
import { LoadError, Section, useLoad } from '../kit';
import styles from '../ssp.module.css';

const TOTAL_REQUIREMENTS = loadCatalog().requirements.length;
/** The SSP requirement: no SPRS score without it. */
const SSP_REQUIREMENT = 'CA.L2-3.12.4';

/** How many requirements hold a statement that isn't blank. */
function countStatements(view: AssessmentView): number {
  return view.requirementStates.filter((s) => (s.implementationStatement ?? '').trim() !== '')
    .length;
}

function Readiness({ view }: { view: AssessmentView }) {
  const outcome = view.evaluation.outcomes.find((o) => o.requirementId === SSP_REQUIREMENT);
  const status = outcome === undefined ? 'not_assessed' : outcome.allNa ? 'na' : outcome.status;
  return (
    <div className={styles.readiness}>
      <div className={styles.reqLine}>
        <span className={styles.mono}>{SSP_REQUIREMENT}</span>
        <StatusChip status={status} />
      </div>
      <p>
        {`${String(countStatements(view))} of ${String(TOTAL_REQUIREMENTS)} requirements have an implementation statement`}
      </p>
      <p>
        <Link className={styles.link} to="/assessment">
          Open the Assessment
        </Link>
      </p>
    </div>
  );
}

/** Lint & export: how ready the plan is, and the .docx export. */
export function ExportTab() {
  const assessment = useLoad('/api/assessment', assessmentViewSchema);

  let readiness: ReactNode;
  if (assessment.data !== null) {
    readiness = <Readiness view={assessment.data} />;
  } else if (assessment.failed) {
    readiness = (
      <LoadError
        title="Can't load the readiness"
        onRetry={() => {
          void assessment.reload();
        }}
      />
    );
  } else {
    readiness = <p className={styles.muted}>Loading the readiness…</p>;
  }

  return (
    <>
      <Section number={1} title="Readiness">
        {readiness}
      </Section>
      <Section number={2} title="Export">
        <Alert tone="info">The pre-export check comes in a later release.</Alert>
        <a className={styles.export} href="/api/ssp/export" download>
          Export SSP (.docx)
        </a>
      </Section>
    </>
  );
}
