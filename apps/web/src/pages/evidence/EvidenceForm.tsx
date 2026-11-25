import { useRef, useState, type SyntheticEvent } from 'react';
import { Alert, Button, Checkbox, TextArea, TextField } from '../../look';
import styles from './evidence.module.css';
import type { Outcome } from './useEvidence';

export interface EvidenceFormProps {
  onCreate: (body: {
    title: string;
    description: string;
    containsCui: boolean;
    objectiveIds: string[];
  }) => Promise<Outcome>;
}

/** Creates an evidence item. "Contains CUI" is fixed at creation, so the form says so. */
export function EvidenceForm({ onCreate }: EvidenceFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [containsCui, setContainsCui] = useState(false);
  const [titleError, setTitleError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A double click lands before React re-renders the disabled button, so a ref guards it.
  const sending = useRef(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const trimmed = title.trim();
    if (trimmed === '') {
      setTitleError('Enter a title.');
      return;
    }
    setTitleError(undefined);
    setFailure(null);
    sending.current = true;
    setPending(true);
    const outcome = await onCreate({
      title: trimmed,
      description: description.trim(),
      containsCui,
      objectiveIds: [],
    });
    sending.current = false;
    setPending(false);
    if (outcome.ok) {
      setTitle('');
      setDescription('');
      setContainsCui(false);
    } else {
      setFailure(outcome.message);
    }
  }

  return (
    <form
      className={styles.form}
      noValidate
      aria-label="New evidence item"
      onSubmit={(event) => void onSubmit(event)}
    >
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <TextField
        label="Title"
        autoComplete="off"
        maxLength={200}
        value={title}
        error={titleError}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <TextArea
        label="Description"
        maxLength={4000}
        value={description}
        onChange={(event) => {
          setDescription(event.target.value);
        }}
      />
      <Checkbox
        label="Contains CUI"
        description="This can't be changed later. A CUI item never holds a file; you record where the file lives."
        checked={containsCui}
        onChange={setContainsCui}
      />
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Creating…' : 'Create evidence item'}
        </Button>
      </div>
    </form>
  );
}
