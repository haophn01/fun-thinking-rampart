import { loadCatalog } from '@rampart/catalog';
import type { FamilyCode, Requirement } from '@rampart/catalog';
import type { ImplementationLevel, ObjectiveStatus } from '@rampart/rules';
import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Button } from '../../look';
import { ScorePanel, useWhatIf } from '../../score';
import { usePageTitle } from '../usePageTitle';
import { FamilyList } from './FamilyList';
import { RequirementDetail } from './RequirementDetail';
import { RequirementList } from './RequirementList';
import styles from './assessment.module.css';
import { useAssessment, type Problem } from './useAssessment';

const catalog = loadCatalog();
const NO_CHANGES: ReadonlySet<string> = new Set();

function ProblemAlert({
  title,
  problem,
  children,
}: {
  title: string;
  problem: Problem;
  children?: ReactNode;
}) {
  return (
    <Alert tone="error" title={title}>
      <p>{problem.message}</p>
      {problem.requestId !== undefined && (
        <p className={styles.requestId}>Request ID: {problem.requestId}</p>
      )}
      {children}
    </Alert>
  );
}

/** The assessment workspace: families, requirements, one requirement's detail, and the score. */
export function AssessmentPage() {
  usePageTitle('Assessment');
  const assessment = useAssessment();
  const whatIf = useWhatIf(assessment.input);
  const [params] = useSearchParams();

  const family: FamilyCode =
    catalog.families.find((f) => f.code === params.get('family'))?.code ??
    (catalog.families[0]?.code as FamilyCode);
  const requirement: Requirement | null =
    catalog.requirements.find((r) => r.id === params.get('req') && r.family === family) ?? null;

  const changed = useMemo(
    () => new Set(whatIf.diff.changed.map((c) => c.requirementId)),
    [whatIf.diff],
  );

  if (assessment.load.status === 'loading') {
    return (
      <section>
        <h1>Assessment</h1>
        <p role="status">Loading assessment…</p>
      </section>
    );
  }
  if (assessment.load.status === 'error' || assessment.evaluation === null) {
    const problem =
      assessment.load.status === 'error'
        ? assessment.load.problem
        : { message: 'The assessment did not load.' };
    return (
      <section>
        <h1>Assessment</h1>
        <ProblemAlert title="The assessment could not be loaded" problem={problem}>
          <div className={styles.retry}>
            <Button onClick={assessment.retry}>Retry</Button>
          </div>
        </ProblemAlert>
      </section>
    );
  }

  const { view } = assessment.load;
  const shown = whatIf.active ? whatIf.evaluation : assessment.evaluation;
  const stateOf = (id: string) =>
    view.requirementStates.find((s) => s.requirementId === id) ?? null;
  const shownStatus = (objectiveId: string): ObjectiveStatus =>
    (whatIf.active ? whatIf.changes.objectiveStatuses?.[objectiveId] : undefined) ??
    assessment.statusOf(objectiveId);
  const shownLevel = (id: string): ImplementationLevel | null => {
    const changes = whatIf.active ? whatIf.changes.implementationLevels : undefined;
    return changes && id in changes
      ? (changes[id] ?? null)
      : (stateOf(id)?.implementationLevel ?? null);
  };

  return (
    <section className={styles.page}>
      <h1>Assessment</h1>
      {assessment.saveProblem && (
        <ProblemAlert title="That change was not saved" problem={assessment.saveProblem} />
      )}

      <div className={styles.top}>
        <ScorePanel
          saved={assessment.evaluation}
          {...(whatIf.active ? { whatIf: whatIf.evaluation, diff: whatIf.diff } : {})}
          catalog={catalog}
        />
        <div className={styles.whatIfControls}>
          {whatIf.active ? (
            <>
              <Button onClick={whatIf.reset}>Reset changes</Button>
              <Button onClick={whatIf.exit}>Exit what-if</Button>
            </>
          ) : (
            <Button onClick={whatIf.start}>Try changes</Button>
          )}
        </div>
      </div>

      <div className={styles.workspace} data-detail={requirement !== null || undefined}>
        <FamilyList catalog={catalog} evaluation={shown} selected={family} />
        <RequirementList
          catalog={catalog}
          family={family}
          evaluation={shown}
          selected={requirement?.id ?? null}
          ownerOf={(id) => stateOf(id)?.owner?.displayName ?? null}
          whatIfChanged={whatIf.active ? changed : NO_CHANGES}
        />
        {requirement && (
          <RequirementDetail
            key={requirement.id}
            requirement={requirement}
            state={stateOf(requirement.id)}
            users={assessment.users}
            whatIf={whatIf.active}
            statusOf={shownStatus}
            noteOf={assessment.noteOf}
            isSaving={assessment.isSaving}
            level={shownLevel(requirement.id)}
            outcome={
              assessment.evaluation.outcomes.find((o) => o.requirementId === requirement.id) ?? null
            }
            patching={assessment.isPatching(requirement.id)}
            backTo={`?family=${family}`}
            onStatus={(objectiveId, status) => {
              if (whatIf.active) whatIf.setObjective(objectiveId, status);
              else void assessment.setStatus(objectiveId, status);
            }}
            onSaveNote={(objectiveId, note) => void assessment.saveNote(objectiveId, note)}
            onLevel={(level) => {
              if (whatIf.active) whatIf.setLevel(requirement.id, level);
              else void assessment.patchRequirement(requirement.id, { implementationLevel: level });
            }}
            onStatement={(statement) =>
              void assessment.patchRequirement(requirement.id, {
                implementationStatement: statement,
              })
            }
            onPlanned={(text) =>
              void assessment.patchRequirement(requirement.id, { plannedImplementation: text })
            }
            onNaRationale={(text) =>
              void assessment.patchRequirement(requirement.id, { naRationale: text })
            }
            onOwner={(ownerId) => void assessment.patchRequirement(requirement.id, { ownerId })}
          />
        )}
      </div>
    </section>
  );
}
