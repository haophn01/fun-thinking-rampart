import {
  ASSESSMENT_TYPE_LABELS,
  CLOSEOUT_CONFIRMER_LABELS,
  assessmentTypeSchema,
  assessmentViewSchema,
  calendarDateSchema,
  type Assessment,
  type AssessmentView,
  type UpdateAssessmentRequest,
} from '@rampart/api/contract';
import { closeoutConfirmer } from '@rampart/rules/poam';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { ApiError, apiGet, apiSend } from '../../api/client';
import { useSession } from '../../auth/session';
import { Alert, Button, RadioGroup, TextField } from '../../look';
import styles from './settings.module.css';

const DATE_ERROR = 'Enter a real date as YYYY-MM-DD.';
const TYPE_OPTIONS = assessmentTypeSchema.options.map((value) => ({
  value,
  label: ASSESSMENT_TYPE_LABELS[value],
}));

type AssessmentType = Assessment['type'];

function saveFailure(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'forbidden':
        return 'Only admins can change these settings.';
      case 'csrf_failed':
        return 'The security check failed. Reload the page and try again.';
      case 'network_error':
        return "Can't reach the API. Check your connection and try again.";
      case 'validation_failed':
        return 'The change was not accepted. Check the fields and try again.';
    }
  }
  return "Couldn't save the change. Try again.";
}

function daysText(days: number): string {
  return `${String(days)} ${days === 1 ? 'day' : 'days'} remaining`;
}

/** The assessment's type and Conditional Status Date. Admins edit; everyone else reads. */
export function AssessmentSettings() {
  const { user } = useSession();
  const canEdit = user?.role === 'admin';
  const [view, setView] = useState<AssessmentView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [type, setType] = useState<AssessmentType>('self');
  const [date, setDate] = useState('');
  const [dateError, setDateError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  const adopt = useCallback((next: AssessmentView) => {
    setView(next);
    setType(next.assessment.type);
    setDate(next.assessment.conditionalStatusDate ?? '');
  }, []);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      adopt(await apiGet('/api/assessment', assessmentViewSchema));
    } catch {
      setLoadError(true);
    }
  }, [adopt]);

  useEffect(() => {
    // load() sets state only after its request answers, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function send(body: UpdateAssessmentRequest) {
    setPending(true);
    setFailure(null);
    setSaved(false);
    try {
      adopt(await apiSend('PATCH', '/api/assessment', body, assessmentViewSchema));
      setDateError(undefined);
      setSaved(true);
    } catch (error) {
      setFailure(saveFailure(error));
    } finally {
      setPending(false);
    }
  }

  const savedDate = view?.assessment.conditionalStatusDate ?? null;
  const draftDate = date.trim() === '' ? null : date.trim();
  const dirty = view !== null && (type !== view.assessment.type || draftDate !== savedDate);

  function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (view === null || pending || !dirty) return;
    if (draftDate !== null && !calendarDateSchema.safeParse(draftDate).success) {
      setDateError(DATE_ERROR);
      return;
    }
    setDateError(undefined);
    const body: UpdateAssessmentRequest = {};
    if (type !== view.assessment.type) body.type = type;
    if (draftDate !== savedDate) body.conditionalStatusDate = draftDate;
    void send(body);
  }

  if (loadError) {
    return (
      <div className={styles.panel}>
        <Alert tone="error">Couldn&apos;t load the assessment settings.</Alert>
        <div>
          <Button
            onClick={() => {
              void load();
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (view === null) return <p className={styles.muted}>Loading the assessment settings…</p>;

  const closeout = view.closeout;
  return (
    <form className={styles.panel} noValidate onSubmit={onSubmit}>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      {saved && <Alert tone="info">Saved.</Alert>}
      <RadioGroup
        legend="Assessment type"
        options={TYPE_OPTIONS}
        value={type}
        disabled={!canEdit || pending}
        onChange={(next) => {
          setType(next);
          setSaved(false);
        }}
      />
      <p>
        <span>Closeout confirmed by:</span>{' '}
        <strong>{CLOSEOUT_CONFIRMER_LABELS[closeoutConfirmer(type)]}</strong>
      </p>
      <TextField
        label="Conditional Status Date"
        placeholder="YYYY-MM-DD"
        autoComplete="off"
        value={date}
        disabled={!canEdit || pending}
        error={dateError}
        onChange={(event) => {
          setDate(event.target.value);
          setSaved(false);
        }}
      />
      {closeout !== null && (
        <div className={styles.identity}>
          <p>{`Deadline ${closeout.deadline}`}</p>
          <p>{closeout.expired ? 'Expired' : daysText(closeout.daysRemaining)}</p>
        </div>
      )}
      {canEdit && (
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={pending || !dirty}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
          {savedDate !== null && (
            <Button
              disabled={pending}
              onClick={() => {
                void send({ conditionalStatusDate: null });
              }}
            >
              Clear date
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
