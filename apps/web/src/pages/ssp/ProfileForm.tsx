import {
  SYSTEM_PROFILE_FIELDS,
  patchSystemProfileRequestSchema,
  type SystemProfile,
  type SystemProfileFieldKey,
} from '@rampart/api/contract';
import { useId, useState, type SyntheticEvent } from 'react';
import { ApiError } from '../../api/client';
import { Alert, Button, TextArea, TextField } from '../../look';
import styles from './ssp.module.css';

type Draft = Record<SystemProfileFieldKey, string>;
export type ProfilePatch = Partial<Record<SystemProfileFieldKey, string | null>>;
type FieldErrors = Partial<Record<SystemProfileFieldKey, string | undefined>>;

/** The fields the contract allows 20,000 characters; the rest are one line. */
const LONG_FIELDS: ReadonlySet<SystemProfileFieldKey> = new Set([
  'description',
  'authorizationBoundary',
  'environment',
  'interconnections',
  'informationTypes',
]);

/** The fields that hold an email address. */
const EMAIL_FIELDS: ReadonlySet<SystemProfileFieldKey> = new Set([
  'systemOwnerEmail',
  'securityContactEmail',
]);

function toDraft(profile: SystemProfile): Draft {
  const draft = {} as Draft;
  for (const { key } of SYSTEM_PROFILE_FIELDS) draft[key] = profile[key] ?? '';
  return draft;
}

type Parsed = { ok: true; value: string | null } | { ok: false; message: string };

/** One field through the contract's own rule: trimmed, blank as `null`, CAGE upper-cased. */
function parseField(key: SystemProfileFieldKey, text: string): Parsed {
  const result = patchSystemProfileRequestSchema.safeParse({ [key]: text });
  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'This value is not valid.' };
  }
  return { ok: true, value: (result.data as ProfilePatch)[key] ?? null };
}

/** The Alert text for a failed save. A 400 carries the server's own message. */
function failureText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'validation_failed':
        return error.message;
      case 'csrf_failed':
        return 'The security check failed. Reload the page and try again.';
      case 'network_error':
        return "Can't reach the API. Check your connection and try again.";
    }
  }
  return "Couldn't save the profile. Try again.";
}

export interface ProfileFormProps {
  profile: SystemProfile;
  /** Sends the changed fields; resolves to the profile as stored. */
  onSave: (patch: ProfilePatch) => Promise<SystemProfile>;
}

/** The system profile: one control per field, and a Save that sends only what changed. */
export function ProfileForm({ profile, onSave }: ProfileFormProps) {
  const headingId = useId();
  const [saved, setSaved] = useState(profile);
  const [draft, setDraft] = useState(() => toDraft(profile));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [pending, setPending] = useState(false);

  const dirtyKeys = SYSTEM_PROFILE_FIELDS.map(({ key }) => key).filter((key) => {
    const parsed = parseField(key, draft[key]);
    // An invalid value counts as a change if the text differs from what is stored.
    return parsed.ok ? parsed.value !== saved[key] : draft[key] !== (saved[key] ?? '');
  });

  function edit(key: SystemProfileFieldKey, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      return { ...current, [key]: undefined };
    });
    setJustSaved(false);
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || dirtyKeys.length === 0) return;
    const found: FieldErrors = {};
    const patch: ProfilePatch = {};
    for (const key of dirtyKeys) {
      const parsed = parseField(key, draft[key]);
      if (parsed.ok) patch[key] = parsed.value;
      else found[key] = parsed.message;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    setJustSaved(false);
    setPending(true);
    try {
      const stored = await onSave(patch);
      setSaved(stored);
      setDraft(toDraft(stored));
      setJustSaved(true);
    } catch (caught) {
      setFailure(failureText(caught));
    } finally {
      setPending(false);
    }
  }

  const lastSaved =
    saved.updatedAt !== null && saved.updatedBy !== null
      ? `Last saved ${new Date(saved.updatedAt).toLocaleString()} by ${saved.updatedBy.displayName}`
      : 'Not saved yet.';

  return (
    <form
      className={styles.form}
      aria-labelledby={headingId}
      noValidate
      onSubmit={(event) => void onSubmit(event)}
    >
      <h3 id={headingId} hidden>
        System profile
      </h3>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      {SYSTEM_PROFILE_FIELDS.map(({ key, label }) =>
        LONG_FIELDS.has(key) ? (
          <TextArea
            key={key}
            label={label}
            value={draft[key]}
            error={errors[key]}
            onChange={(event) => {
              edit(key, event.target.value);
            }}
          />
        ) : (
          <TextField
            key={key}
            label={label}
            type={EMAIL_FIELDS.has(key) ? 'email' : 'text'}
            autoComplete="off"
            value={draft[key]}
            error={errors[key]}
            onChange={(event) => {
              edit(key, event.target.value);
            }}
          />
        ),
      )}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={pending || dirtyKeys.length === 0}>
          {pending ? 'Saving…' : 'Save profile'}
        </Button>
        {justSaved && (
          <span className={styles.saved} role="status">
            Saved
          </span>
        )}
      </div>
      <p className={styles.lastSaved}>{lastSaved}</p>
    </form>
  );
}
