import {
  CLOSEOUT_CONFIRMER_LABELS,
  calendarDateSchema,
  type CloseoutConfirmer,
  type CloseoutRequest,
} from '@rampart/api/contract';
import { useRef, useState, type SyntheticEvent } from 'react';
import type { ApiError } from '../../api/client';
import { Alert, Button, TextArea, TextField } from '../../look';
import { DATE_ERROR } from './MilestonesEditor';
import styles from './poam.module.css';

export interface CloseoutFormProps {
  requirementId: string;
  confirmer: CloseoutConfirmer;
  /** Sends the closeout; resolves to `null` when recorded, or the error to show. */
  onSubmit: (body: CloseoutRequest) => Promise<ApiError | null>;
  onClose: () => void;
}

/** Admin-only: the day the item closed, a note, and (for a C3PAO assessment) who confirmed it. */
export function CloseoutForm({ requirementId, confirmer, onSubmit, onClose }: CloseoutFormProps) {
  const [closedOn, setClosedOn] = useState('');
  const [note, setNote] = useState('');
  const [c3paoName, setC3paoName] = useState('');
  const [errors, setErrors] = useState<{ closedOn?: string; c3paoName?: string }>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const needsName = confirmer === 'c3pao';

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const next: { closedOn?: string; c3paoName?: string } = {};
    if (!calendarDateSchema.safeParse(closedOn.trim()).success) next.closedOn = DATE_ERROR;
    if (needsName && c3paoName.trim() === '') next.c3paoName = 'Enter the C3PAO name.';
    setErrors(next);
    if (next.closedOn !== undefined || next.c3paoName !== undefined) return;

    const body: CloseoutRequest = {
      closedOn: closedOn.trim(),
      note: note.trim() === '' ? null : note.trim(),
    };
    if (needsName) body.c3paoName = c3paoName.trim();
    sending.current = true;
    setPending(true);
    setFailure(null);
    const result = await onSubmit(body);
    sending.current = false;
    setPending(false);
    if (result === null) onClose();
    else setFailure(result);
  }

  return (
    <form
      className={styles.form}
      aria-label={`Close out ${requirementId}`}
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <p>{`Confirmed by: ${CLOSEOUT_CONFIRMER_LABELS[confirmer]}`}</p>
      {failure !== null && (
        <Alert tone="error" title="The closeout was not recorded">
          <p>{failure.message}</p>
          {failure.requestId !== undefined && (
            <p className={styles.mono}>{`Request ID: ${failure.requestId}`}</p>
          )}
        </Alert>
      )}
      <TextField
        label="Closed on"
        placeholder="YYYY-MM-DD"
        autoComplete="off"
        value={closedOn}
        disabled={pending}
        error={errors.closedOn}
        onChange={(event) => {
          setClosedOn(event.target.value);
        }}
      />
      {needsName && (
        <TextField
          label="C3PAO name"
          autoComplete="off"
          maxLength={200}
          value={c3paoName}
          disabled={pending}
          error={errors.c3paoName}
          onChange={(event) => {
            setC3paoName(event.target.value);
          }}
        />
      )}
      <TextArea
        label="Note (optional)"
        rows={3}
        maxLength={4000}
        value={note}
        disabled={pending}
        onChange={(event) => {
          setNote(event.target.value);
        }}
      />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Record closeout'}
        </Button>
        <Button disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
