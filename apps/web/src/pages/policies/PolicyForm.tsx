import { useId, useState, type SyntheticEvent } from 'react';
import { Alert, Button, TextArea, TextField } from '../../look';
import styles from './policies.module.css';
import { failureText } from './usePolicies';

export interface PolicyFormProps {
  onCreate: (body: { title: string; description: string }) => Promise<void>;
}

/** Add a policy: a title (required) and an optional description. Files come after, per policy. */
export function PolicyForm({ onCreate }: PolicyFormProps) {
  const headingId = useId();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (title.trim() === '') {
      setError('Enter a title.');
      return;
    }
    setError(undefined);
    setFailure(null);
    setPending(true);
    try {
      await onCreate({ title: title.trim(), description: description.trim() });
      setTitle('');
      setDescription('');
    } catch (caught) {
      setFailure(failureText(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className={styles.create}
      aria-labelledby={headingId}
      noValidate
      onSubmit={(event) => void onSubmit(event)}
    >
      <h3 id={headingId} className={styles.formHead}>
        Add a policy
      </h3>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <TextField
        label="Title"
        autoComplete="off"
        maxLength={200}
        value={title}
        error={error}
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
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Adding…' : 'Add policy'}
        </Button>
      </div>
    </form>
  );
}
