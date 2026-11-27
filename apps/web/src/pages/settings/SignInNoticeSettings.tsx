import {
  SIGN_IN_NOTICE_MAX_LENGTH,
  signInNoticeResponseSchema,
  type UpdateSignInNoticeRequest,
} from '@rampart/api/contract';
import { useState, type SyntheticEvent } from 'react';
import { ApiError, apiSend } from '../../api/client';
import { useSession } from '../../auth/session';
import { Alert, Button, TextArea } from '../../look';
import styles from './SignInNoticeSettings.module.css';
import settings from './settings.module.css';

const TOO_LONG = `Use at most ${String(SIGN_IN_NOTICE_MAX_LENGTH)} characters.`;

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
        return 'The notice was not accepted. Check the text and try again.';
    }
  }
  return "Couldn't save the notice. Try again.";
}

/** Settings › Sign-in notice (admin): edit the notice every sign-in acknowledges, or clear it. */
export function SignInNoticeSettings() {
  const session = useSession();
  const saved = session.signInNotice?.text ?? '';
  const [text, setText] = useState(saved);
  const [error, setError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function send(body: UpdateSignInNoticeRequest) {
    setPending(true);
    setFailure(null);
    setDone(false);
    try {
      const result = await apiSend(
        'PUT',
        '/api/settings/sign-in-notice',
        body,
        signInNoticeResponseSchema,
      );
      setText(result.signInNotice?.text ?? '');
      setDone(true);
      await session.refresh();
    } catch (caught) {
      setFailure(saveFailure(caught));
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (text.trim().length > SIGN_IN_NOTICE_MAX_LENGTH) {
      setError(TOO_LONG);
      return;
    }
    setError(undefined);
    void send({ text });
  }

  return (
    <form className={[settings.panel, styles.form].join(' ')} noValidate onSubmit={onSubmit}>
      <p className={styles.hint}>
        {session.signInNotice === null
          ? 'Off. Sign-in shows no notice.'
          : 'On. Everyone acknowledges this notice before signing in.'}
      </p>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      {done && <Alert tone="info">Saved.</Alert>}
      <TextArea
        label="Notice text"
        rows={8}
        maxLength={SIGN_IN_NOTICE_MAX_LENGTH}
        value={text}
        error={error}
        disabled={pending}
        onChange={(event) => {
          setText(event.target.value);
          setDone(false);
          setError(undefined);
        }}
      />
      <div className={settings.actions}>
        <Button type="submit" variant="primary" disabled={pending || text === saved}>
          {pending ? 'Saving…' : 'Save notice'}
        </Button>
        <Button
          disabled={pending || (session.signInNotice === null && text === '')}
          onClick={() => {
            void send({ text: null });
          }}
        >
          Clear
        </Button>
      </div>
    </form>
  );
}
