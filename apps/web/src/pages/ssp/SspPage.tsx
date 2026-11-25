import {
  assessmentViewSchema,
  systemProfileResponseSchema,
  type AssessmentView,
  type SystemProfile,
} from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { apiGet, apiSend, type ResponseSchema } from '../../api/client';
import { Alert, Button, SectionLabel, StatusChip } from '../../look';
import { usePageTitle } from '../usePageTitle';
import { ProfileForm, type ProfilePatch } from './ProfileForm';
import styles from './ssp.module.css';

const TOTAL_REQUIREMENTS = loadCatalog().requirements.length;
/** The SSP requirement: no SPRS score without it. */
const SSP_REQUIREMENT = 'CA.L2-3.12.4';

interface Loaded<T> {
  /** `null` until the first load answers. */
  data: T | null;
  failed: boolean;
  reload: () => Promise<void>;
}

/** Loads one GET on mount. A failed reload keeps the data it had; only a first load shows the error. */
function useLoad<T>(path: string, schema: ResponseSchema<T>): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  // Each load bumps this; an answer from an older load (or after unmount) is dropped.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    latest.current += 1;
    const run = latest.current;
    const body = await apiGet(path, schema).then(
      (value) => value,
      () => null,
    );
    if (run !== latest.current) return;
    if (body !== null) setData(body);
    setFailed(body === null);
  }, [path, schema]);
  useEffect(() => {
    // reload() sets state only after its request answers, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    return () => {
      latest.current += 1;
    };
  }, [reload]);
  return { data, failed, reload };
}

function Section({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionHead}>
        <SectionLabel number={number}>{title}</SectionLabel>
      </h2>
      {children}
    </section>
  );
}

function LoadError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <Alert tone="error" title={title}>
      <p>Check that the API is running, then retry.</p>
      <Button className={styles.retry} onClick={onRetry}>
        Retry
      </Button>
    </Alert>
  );
}

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

/** The SSP page: the system profile, how ready the plan is, and the .docx export. */
export function SspPage() {
  usePageTitle('SSP');
  const profile = useLoad('/api/system-profile', systemProfileResponseSchema);
  const assessment = useLoad('/api/assessment', assessmentViewSchema);

  const save = useCallback(async (patch: ProfilePatch): Promise<SystemProfile> => {
    const { profile: stored } = await apiSend(
      'PATCH',
      '/api/system-profile',
      patch,
      systemProfileResponseSchema,
    );
    return stored;
  }, []);

  let form: ReactNode;
  if (profile.data !== null) {
    form = <ProfileForm profile={profile.data.profile} onSave={save} />;
  } else if (profile.failed) {
    form = (
      <LoadError
        title="Can't load the system profile"
        onRetry={() => {
          void profile.reload();
        }}
      />
    );
  } else {
    form = <p className={styles.muted}>Loading the system profile…</p>;
  }

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
    <section className={styles.page}>
      <h1>SSP</h1>
      <Section number={1} title="System profile">
        {form}
      </Section>
      <Section number={2} title="Readiness">
        {readiness}
      </Section>
      <Section number={3} title="Export">
        <a className={styles.export} href="/api/ssp/export" download>
          Export SSP (.docx)
        </a>
      </Section>
    </section>
  );
}
