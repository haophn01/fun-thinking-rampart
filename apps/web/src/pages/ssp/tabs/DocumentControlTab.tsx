import {
  approvalResponseSchema,
  calendarDateSchema,
  documentControlSchema,
  revisionResponseSchema,
  sspProfileResponseSchema,
  type DocumentControl,
  type SspApproval,
  type SspRevision,
} from '@rampart/api/contract';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { ApiError, apiSend } from '../../../api/client';
import { useSession } from '../../../auth/session';
import { Alert, Button, TextArea, TextField } from '../../../look';
import {
  DATE_MESSAGE,
  LoadError,
  RemoveButton,
  Section,
  SspProfileForm,
  SspTable,
  errorText,
  fieldErrors,
  useLoad,
  type Loaded,
  type SspColumn,
} from '../kit';
import styles from './document-control.module.css';

const FUTURE_MESSAGE = "The date can't be in the future.";
const SAVE_FAILED = "Couldn't save. Try again.";
const LONG = 'Use 200 characters or fewer.';
const GONE = 'It was already removed. The list has been reloaded.';

/** Today's date in UTC, as YYYY-MM-DD. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A date field's text: a real YYYY-MM-DD, not after today. Returns the message when it isn't. */
function checkDate(text: string): string | null {
  const value = text.trim();
  if (!calendarDateSchema.safeParse(value).success) return DATE_MESSAGE;
  return value > utcToday() ? FUTURE_MESSAGE : null;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'not_found';
}

function days(n: number, word: string): string {
  return `${String(n)} ${n === 1 ? 'day' : 'days'} ${word}`;
}

function ReviewStatus({ control }: { control: DocumentControl }) {
  const { nextReviewDue: due, daysToReview: left, reviewOverdue } = control;
  if (due === null) {
    return (
      <p className={styles.status}>
        No review date yet. Set a next review date or record an approval.
      </p>
    );
  }
  if (reviewOverdue) {
    return (
      <Alert tone="error" title="Review overdue">
        {`Due ${due} · ${days(Math.abs(left ?? 0), 'overdue')}`}
      </Alert>
    );
  }
  if (left === 0) return <p className={styles.status}>{`Next review due today (${due})`}</p>;
  return <p className={styles.status}>{`Next review due ${due} · ${days(left ?? 0, 'left')}`}</p>;
}

/** Shows `children` once `load` has data; else its loading text, or its error with Retry. */
function WhenLoaded({
  load,
  what,
  children,
}: {
  load: Pick<Loaded<unknown>, 'data' | 'failed' | 'reload'>;
  what: string;
  children: ReactNode;
}) {
  if (load.data !== null) return <>{children}</>;
  if (load.failed) {
    return (
      <LoadError
        title={`Can't load ${what}`}
        onRetry={() => {
          void load.reload();
        }}
      />
    );
  }
  return <p className={styles.note}>{`Loading ${what}…`}</p>;
}

function ReviewSection({ control }: { control: Loaded<DocumentControl> }) {
  const profile = useLoad('/api/ssp/profile', sspProfileResponseSchema);
  return (
    <Section number={1} title="Review">
      <div className={styles.stack}>
        <WhenLoaded load={control} what="the review status">
          {control.data !== null && <ReviewStatus control={control.data} />}
        </WhenLoaded>
        <WhenLoaded load={profile} what="the review schedule">
          {profile.data !== null && (
            <SspProfileForm
              title="Review schedule"
              groups={['review']}
              profile={profile.data.profile}
              onSaved={() => {
                void control.reload();
              }}
            />
          )}
        </WhenLoaded>
      </div>
    </Section>
  );
}

function ChangeForm({ onAdded }: { onAdded: () => void }) {
  const [date, setDate] = useState(utcToday);
  const [description, setDescription] = useState('');
  const [madeBy, setMadeBy] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found: Record<string, string> = {};
    const dateProblem = checkDate(date);
    if (dateProblem !== null) found.date = dateProblem;
    if (description.trim() === '') found.description = 'Enter a description.';
    else if (description.trim().length > 2000) found.description = 'Use 2,000 characters or fewer.';
    if (madeBy.trim().length > 200) found.madeBy = LONG;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body: { date: string; description: string; madeBy?: string } = {
      date: date.trim(),
      description: description.trim(),
    };
    if (madeBy.trim() !== '') body.madeBy = madeBy.trim();
    setFailure(null);
    setPending(true);
    try {
      await apiSend('POST', '/api/ssp/revisions', body, revisionResponseSchema);
      setDescription('');
      setMadeBy('');
      setDate(utcToday());
      onAdded();
    } catch (caught) {
      const byField = fieldErrors(caught);
      if (Object.keys(byField).length > 0) setErrors(byField);
      else setFailure(errorText(caught, SAVE_FAILED));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className={styles.form}
      aria-label="Add a change"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <TextField
        label="Date"
        value={date}
        error={errors.date}
        placeholder="YYYY-MM-DD"
        autoComplete="off"
        onChange={(event) => {
          setDate(event.target.value);
        }}
      />
      <TextArea
        label="Description"
        value={description}
        error={errors.description}
        maxLength={2000}
        onChange={(event) => {
          setDescription(event.target.value);
        }}
      />
      <TextField
        label="Made by"
        value={madeBy}
        error={errors.madeBy}
        autoComplete="off"
        onChange={(event) => {
          setMadeBy(event.target.value);
        }}
      />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={pending}>
          Add entry
        </Button>
      </div>
    </form>
  );
}

const REVISION_COLUMNS: readonly SspColumn<SspRevision>[] = [
  { header: 'Date', cell: (row) => row.date },
  { header: 'Description', cell: (row) => row.description },
  { header: 'Made by', cell: (row) => row.madeBy },
  { header: 'Kind', cell: (row) => (row.kind === 'export' ? 'Export' : 'Manual') },
];

function ChangesSection({ control }: { control: Loaded<DocumentControl> }) {
  return (
    <Section number={2} title="Record of changes">
      <div className={styles.stack}>
        <WhenLoaded load={control} what="the record of changes">
          {control.data !== null && (
            <>
              <SspTable
                caption="Record of changes"
                columns={REVISION_COLUMNS}
                rows={control.data.revisions}
                rowKey={(row) => row.id}
                empty="No changes recorded yet."
              />
              <p className={styles.note}>Entries can't be changed or removed.</p>
              <ChangeForm
                onAdded={() => {
                  void control.reload();
                }}
              />
            </>
          )}
        </WhenLoaded>
      </div>
    </Section>
  );
}

function ApprovalForm({
  editing,
  onDone,
  onCancel,
  onGone,
}: {
  editing: SspApproval | null;
  /** The write succeeded. */
  onDone: () => void;
  onCancel: () => void;
  /** The approval being edited no longer exists. */
  onGone: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [title, setTitle] = useState(editing?.title ?? '');
  const [approvedOn, setApprovedOn] = useState(editing?.approvedOn ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const next = {
    name: name.trim(),
    title: title.trim(),
    approvedOn: approvedOn.trim() === '' ? null : approvedOn.trim(),
  };
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
    (key) => editing === null || next[key] !== editing[key],
  );

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || changed.length === 0) return;
    const found: Record<string, string> = {};
    if (next.name === '') found.name = 'Enter a name.';
    else if (next.name.length > 200) found.name = LONG;
    if (next.title === '') found.title = 'Enter a title.';
    else if (next.title.length > 200) found.title = LONG;
    const dateProblem = next.approvedOn === null ? null : checkDate(next.approvedOn);
    if (dateProblem !== null) found.approvedOn = dateProblem;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    setPending(true);
    try {
      if (editing === null) {
        await apiSend('POST', '/api/ssp/approvals', next, approvalResponseSchema);
        setName('');
        setTitle('');
        setApprovedOn('');
      } else {
        const patch = Object.fromEntries(changed.map((key) => [key, next[key]]));
        await apiSend('PATCH', `/api/ssp/approvals/${editing.id}`, patch, approvalResponseSchema);
      }
      onDone();
    } catch (caught) {
      const byField = fieldErrors(caught);
      if (Object.keys(byField).length > 0) setErrors(byField);
      else if (isNotFound(caught)) onGone();
      else setFailure(errorText(caught, SAVE_FAILED));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className={styles.form}
      aria-label={editing === null ? 'Add an approval' : 'Edit approval'}
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <p className={styles.formTitle}>
        {editing === null ? 'Add an approval' : `Edit ${editing.name}`}
      </p>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <TextField
        label="Name"
        value={name}
        error={errors.name}
        autoComplete="off"
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <TextField
        label="Title"
        value={title}
        error={errors.title}
        autoComplete="off"
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <TextField
        label="Approved on"
        value={approvedOn}
        error={errors.approvedOn}
        placeholder="YYYY-MM-DD"
        autoComplete="off"
        onChange={(event) => {
          setApprovedOn(event.target.value);
        }}
      />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={pending || changed.length === 0}>
          {editing === null ? 'Add approval' : 'Save approval'}
        </Button>
        {editing !== null && (
          <Button type="button" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function ApprovalsSection({
  control,
  isAdmin,
}: {
  control: Loaded<DocumentControl>;
  isAdmin: boolean;
}) {
  const [editing, setEditing] = useState<SspApproval | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function remove(approval: SspApproval) {
    setNotice(null);
    try {
      await apiSend('DELETE', `/api/ssp/approvals/${approval.id}`);
      if (editing?.id === approval.id) setEditing(null);
    } catch (caught) {
      setNotice(errorText(caught, "Couldn't remove. Try again."));
      if (!isNotFound(caught)) return;
      if (editing?.id === approval.id) setEditing(null);
    }
    await control.reload();
  }

  const columns: SspColumn<SspApproval>[] = [
    { header: 'Name', cell: (row) => row.name },
    { header: 'Title', cell: (row) => row.title },
    { header: 'Approved on', cell: (row) => row.approvedOn ?? 'Not signed yet' },
  ];
  if (isAdmin) {
    columns.push({
      header: 'Actions',
      cell: (row) => (
        <span className={styles.rowActions}>
          <Button
            aria-label={`Edit ${row.name}`}
            onClick={() => {
              setNotice(null);
              setEditing(row);
            }}
          >
            Edit
          </Button>
          <RemoveButton
            name={row.name}
            onConfirm={() => {
              return remove(row);
            }}
          />
        </span>
      ),
    });
  }

  return (
    <Section number={3} title="Approvals">
      <div className={styles.stack}>
        <WhenLoaded load={control} what="the approvals">
          {control.data !== null && (
            <>
              {notice !== null && <Alert tone="error">{notice}</Alert>}
              <SspTable
                caption="Approvals"
                columns={columns}
                rows={control.data.approvals}
                rowKey={(row) => row.id}
                empty="No approvals yet."
              />
              <p className={styles.note}>Each approval prints as a signature line in the SSP.</p>
              {isAdmin ? (
                <ApprovalForm
                  key={editing?.id ?? 'new'}
                  editing={editing}
                  onDone={() => {
                    setNotice(null);
                    setEditing(null);
                    void control.reload();
                  }}
                  onCancel={() => {
                    setEditing(null);
                  }}
                  onGone={() => {
                    setNotice(GONE);
                    setEditing(null);
                    void control.reload();
                  }}
                />
              ) : (
                <p className={styles.note}>Only an admin can change approvals.</p>
              )}
            </>
          )}
        </WhenLoaded>
      </div>
    </Section>
  );
}

/** Document control: the review schedule, the record of changes and the approvals. */
export function DocumentControlTab() {
  const { user } = useSession();
  const control = useLoad('/api/ssp/document-control', documentControlSchema);
  return (
    <>
      <ReviewSection control={control} />
      <ChangesSection control={control} />
      <ApprovalsSection control={control} isAdmin={user?.role === 'admin'} />
    </>
  );
}
