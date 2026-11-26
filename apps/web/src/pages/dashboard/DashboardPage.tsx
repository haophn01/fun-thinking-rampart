import {
  assessmentViewSchema,
  documentControlSchema,
  type DocumentControl,
  poamViewSchema,
  systemProfileResponseSchema,
  type AssessmentView,
  type PoamView,
  type SystemProfile,
} from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import { REGULATION } from '@rampart/rules/poam';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiGet } from '../../api/client';
import { useSession } from '../../auth/session';
import {
  Alert,
  Button,
  DimensionRuler,
  FeatureControlFrame,
  GraduatedBar,
  InspectionStamp,
  InspectionStrip,
  SectionLabel,
  StatusChip,
} from '../../look';
import { blockerText } from '../../score';
import { usePageTitle } from '../usePageTitle';
import { needsAttention } from './attention';
import styles from './dashboard.module.css';
import { familyRows, objectiveCounts } from './summary';

const catalog = loadCatalog();
const OBJECTIVE_TOTAL = catalog.requirements.reduce((n, r) => n + r.objectives.length, 0);
const THRESHOLD = REGULATION.conditionalMinScore.value;
const WINDOW_DAYS = REGULATION.closeoutWindowDays.value;

const STATUS_LABEL: Record<AssessmentView['evaluation']['conditional']['status'], string> = {
  final: 'Final status reachable',
  conditional: 'Conditional status reachable',
  not_eligible: 'Not eligible',
  incomplete: 'Assessment incomplete',
};

const SSP_MESSAGE = 'System Security Plan must be Met before a score exists';

interface Problem {
  message: string;
  requestId?: string | undefined;
}

interface Data {
  view: AssessmentView;
  poam: PoamView;
  profile: SystemProfile;
  /** Null when the document-control call failed: the dashboard just omits the review row. */
  control: DocumentControl | null;
}

type Load =
  { status: 'loading' } | { status: 'error'; problem: Problem } | { status: 'ready'; data: Data };

function problemOf(error: unknown): Problem {
  if (error instanceof ApiError) return { message: error.message, requestId: error.requestId };
  return { message: 'Something went wrong.' };
}

/** Loads the assessment, the POA&M and the system profile together. */
function useDashboard(): { load: Load; retry: () => void } {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const live = { on: true };
    void (async () => {
      try {
        const controlCall = apiGet('/api/ssp/document-control', documentControlSchema).catch(
          () => null,
        );
        const [view, poam, profile, control] = await Promise.all([
          apiGet('/api/assessment', assessmentViewSchema),
          apiGet('/api/poam', poamViewSchema),
          apiGet('/api/system-profile', systemProfileResponseSchema),
          controlCall,
        ]);
        if (live.on)
          setLoad({ status: 'ready', data: { view, poam, profile: profile.profile, control } });
      } catch (error) {
        if (live.on) setLoad({ status: 'error', problem: problemOf(error) });
      }
    })();
    return () => {
      live.on = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setLoad({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  return { load, retry };
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

function blockerCount(n: number): string {
  return `${String(n)} BLOCKER${n === 1 ? '' : 'S'}`;
}

function scoreSentence(view: AssessmentView): string {
  const { score } = view.evaluation;
  if (score.kind === 'incomplete')
    return `${score.prerequisites[0] ?? 'CA.L2-3.12.4'} ${SSP_MESSAGE}`;
  if (score.score >= THRESHOLD)
    return `At or above the Conditional minimum of ${String(THRESHOLD)}.`;
  const short = THRESHOLD - score.score;
  return `Conditional status needs ${String(THRESHOLD)}. You are ${plural(short, 'point')} short.`;
}

function clockText(closeout: AssessmentView['closeout']): string {
  if (closeout === null) return `${String(WINDOW_DAYS)}-day clock: not started`;
  if (closeout.expired) return 'Closeout deadline passed';
  return `Closeout due ${closeout.deadline} · ${plural(closeout.daysRemaining, 'day')} left`;
}

function ScoreSection({ view }: { view: AssessmentView }) {
  const { score, conditional } = view.evaluation;
  const measured = score.kind === 'scored' ? score.score : null;
  const accept = conditional.status === 'final' || conditional.status === 'conditional';
  const detail = accept
    ? conditional.status === 'final'
      ? 'FINAL'
      : 'CONDITIONAL'
    : blockerCount(conditional.blockers.length);
  return (
    <section className={styles.score} aria-label="SPRS score">
      <h2 className={styles.head}>
        <SectionLabel number={1}>SPRS score</SectionLabel>
      </h2>
      <div className={styles.reading}>
        <div className={styles.readingText}>
          <span className={styles.value} data-testid="score-value">
            {measured === null ? '—' : measured}
          </span>
          <span className={styles.max}>/ {score.max}</span>
        </div>
        <InspectionStamp verdict={accept ? 'accept' : 'hold'} detail={detail} />
      </div>
      <DimensionRuler value={measured} floor={score.floor} max={score.max} threshold={THRESHOLD} />
      <FeatureControlFrame measured={measured} lsl={THRESHOLD} usl={score.max} />
      <p className={styles.sentence}>{scoreSentence(view)}</p>
      <Link className={styles.link} to="/assessment">
        Continue assessment
      </Link>
    </section>
  );
}

function ConditionalSection({ view, poam }: { view: AssessmentView; poam: PoamView }) {
  const { conditional } = view.evaluation;
  const blockers =
    view.evaluation.score.kind === 'incomplete'
      ? conditional.blockers.filter((b) => b.code !== 'prerequisite_not_met')
      : conditional.blockers;
  const open = poam.items.filter((item) => item.status === 'open').length;
  return (
    <section className={styles.conditional} aria-label="Conditional check">
      <h2 className={styles.head}>
        <SectionLabel number={2}>Conditional check</SectionLabel>
      </h2>
      <p className={styles.status}>{STATUS_LABEL[conditional.status]}</p>
      {blockers.length > 0 && (
        <ul className={styles.blockers} aria-label="Blockers">
          {blockers.map((blocker, index) => (
            <li key={`${blocker.code}-${String(index)}`} className={styles.blocker}>
              <span>{blockerText(blocker, catalog)}</span>
              {'citation' in blocker && <span className={styles.cite}>{blocker.citation}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className={styles.fact}>POA&amp;M · {String(open)} open</p>
      <p className={styles.fact}>{clockText(view.closeout)}</p>
    </section>
  );
}

const COUNT_ORDER = ['met', 'not_met', 'na', 'not_assessed'] as const;

function ObjectivesSection({ view }: { view: AssessmentView }) {
  const counts = objectiveCounts(view.objectiveResults, catalog);
  const assessed = counts.total - counts.not_assessed;
  const label = `Objectives · ${String(counts.total)}`;
  return (
    <section className={styles.objectives} aria-label={label}>
      <h2 className={styles.head}>
        <SectionLabel number={3}>{label}</SectionLabel>
      </h2>
      <ul className={styles.counts}>
        {COUNT_ORDER.map((status) => (
          <li key={status} className={styles.count}>
            <StatusChip status={status} />
            <span className={styles.number} data-testid={`count-${status}`}>
              {counts[status]}
            </span>
          </li>
        ))}
      </ul>
      <GraduatedBar
        label="Objectives assessed"
        value={counts.total === 0 ? 0 : (assessed / counts.total) * 100}
      />
    </section>
  );
}

function FamiliesSection({ view }: { view: AssessmentView }) {
  const rows = familyRows(view.objectiveResults, view.evaluation.outcomes, catalog);
  const label = `Families · ${String(rows.length)}`;
  return (
    <section className={styles.families} aria-label={label}>
      <h2 className={styles.head}>
        <SectionLabel number={4}>{label}</SectionLabel>
      </h2>
      <ul className={styles.familyList}>
        {rows.map((row) => (
          <li key={row.code} className={styles.family}>
            <span className={styles.familyName}>
              <span className={styles.mono}>{row.code}</span> {row.name}
            </span>
            <GraduatedBar label={`${row.name} objectives assessed`} value={row.percent} />
            <span className={styles.familyCounts}>
              Met {String(row.met)} · Not Met {String(row.notMet)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AttentionSection({
  view,
  poam,
  control,
}: {
  view: AssessmentView;
  poam: PoamView;
  control: DocumentControl | null;
}) {
  const rows = useMemo(() => needsAttention(view, poam, catalog, control), [view, poam, control]);
  return (
    <section className={styles.attention} aria-label="Needs attention">
      <h2 className={styles.head}>
        <SectionLabel number={5}>Needs attention</SectionLabel>
      </h2>
      {rows.length === 0 ? (
        <p className={styles.fact}>Nothing needs attention.</p>
      ) : (
        <ul className={styles.rows}>
          {rows.map((row) => (
            <li key={row.key} className={styles.row}>
              {row.requirementId === undefined ? (
                <Link className={styles.link} to={row.href}>
                  {row.message}
                </Link>
              ) : (
                <>
                  <span className={styles.rowHead}>
                    <Link className={[styles.link, styles.mono].join(' ')} to={row.href}>
                      {row.requirementId}
                    </Link>
                    {row.chip !== undefined && <StatusChip status={row.chip} />}
                  </span>
                  <span className={styles.rowMessage}>{row.message}</span>
                  {row.text !== undefined && row.text !== '' && (
                    <span className={styles.rowText}>{row.text}</span>
                  )}
                  <span className={styles.rowMeta}>
                    {row.points !== null && row.points !== undefined && (
                      <span>{plural(row.points, 'point')}</span>
                    )}
                    <span>Owner: {row.owner ?? 'Unassigned'}</span>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The readiness dashboard at `/`: score, Conditional check, objectives, families, attention. */
export function DashboardPage() {
  usePageTitle('Dashboard');
  const { user } = useSession();
  const { load, retry } = useDashboard();

  if (load.status === 'loading') {
    return (
      <section>
        <h1>Dashboard</h1>
        <p role="status" className={styles.muted}>
          Loading…
        </p>
      </section>
    );
  }
  if (load.status === 'error') {
    const { problem } = load;
    return (
      <section>
        <h1>Dashboard</h1>
        <Alert tone="error" title="The dashboard could not be loaded">
          <p>{problem.message}</p>
          {problem.requestId !== undefined && (
            <p className={styles.mono}>{`Request ID: ${problem.requestId}`}</p>
          )}
          <div className={styles.retry}>
            <Button onClick={retry}>Retry</Button>
          </div>
        </Alert>
      </section>
    );
  }

  const { view, poam, profile, control } = load.data;
  return (
    <div className={styles.page}>
      <h1>Dashboard</h1>
      <div className={styles.grid}>
        <ScoreSection view={view} />
        <ConditionalSection view={view} poam={poam} />
        <ObjectivesSection view={view} />
        <AttentionSection view={view} poam={poam} control={control} />
        <FamiliesSection view={view} />
      </div>
      <InspectionStrip
        entries={[
          { label: 'IR', value: `IR-${view.assessment.id.slice(0, 8).toUpperCase()}` },
          { label: 'Part', value: profile.systemName ?? 'System not named' },
          { label: 'Spec', value: view.assessment.catalogVersion },
          { label: 'Characteristics', value: String(OBJECTIVE_TOTAL) },
          { label: 'Inspector', value: user?.displayName ?? '—' },
          { label: 'Date', value: new Date().toISOString().slice(0, 10) },
        ]}
      />
    </div>
  );
}
