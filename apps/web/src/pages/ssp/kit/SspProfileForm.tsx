import {
  DEFAULT_CATEGORIZATION,
  SSP_PROFILE_FIELDS,
  patchSspProfileRequestSchema,
  sspProfileResponseSchema,
  type SspProfile,
  type SspProfileFieldKey,
  type SspProfileGroup,
} from '@rampart/api/contract';
import { useId, useState, type SyntheticEvent } from 'react';
import { apiSend } from '../../../api/client';
import { Alert, Button, TextArea, TextField } from '../../../look';
import { errorText, fieldErrors } from './errors';
import styles from './kit.module.css';

/** The fields the contract allows long text; the rest are one line. */
export const LONG_SSP_FIELDS: ReadonlySet<SspProfileFieldKey> = new Set([
  'organizationAddress',
  'cuiCategories',
  'cuiLocations',
  'cuiEntryExit',
  'topologyNarrative',
  'dataFlowNarrative',
  'inventoryReference',
  'maintenanceStatement',
]);

export const CADENCE_MESSAGE = 'Enter a whole number of months from 1 to 60';
export const DATE_MESSAGE = 'Enter a real date as YYYY-MM-DD.';
const SAVE_FAILED = "Couldn't save. Try again.";

type Value = string | number | null;
type Draft = Partial<Record<SspProfileFieldKey, string>>;
type Errors = Partial<Record<SspProfileFieldKey, string>>;
type Parsed = { ok: true; value: Value } | { ok: false; message: string };

/** One key through the contract's own rule. */
function check(key: SspProfileFieldKey, value: unknown): Parsed {
  const result = patchSspProfileRequestSchema.safeParse({ [key]: value });
  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'This value is not valid.' };
  }
  return { ok: true, value: (result.data as Record<string, Value | undefined>)[key] ?? null };
}

/** A field's text as the value it would send: trimmed, blank as `null`, cadence as a number. */
export function parseSspField(key: SspProfileFieldKey, text: string): Parsed {
  const trimmed = text.trim();
  if (key === 'reviewCadenceMonths') {
    const parsed = /^\d+$/.test(trimmed) ? check(key, Number(trimmed)) : null;
    return parsed?.ok === true ? parsed : { ok: false, message: CADENCE_MESSAGE };
  }
  if (key === 'nextReviewDate') {
    if (trimmed === '') return { ok: true, value: null };
    const parsed = check(key, trimmed);
    return parsed.ok ? parsed : { ok: false, message: DATE_MESSAGE };
  }
  return check(key, text);
}

/** What a value reads as once stored: a blank categorization reads as the default. */
function effective(key: SspProfileFieldKey, value: Value): Value {
  return key === 'categorization' && value === null ? DEFAULT_CATEGORIZATION : value;
}

function asText(value: Value): string {
  return value === null ? '' : String(value);
}

function toDraft(fields: readonly { key: SspProfileFieldKey }[], from: SspProfile): Draft {
  const next: Draft = {};
  for (const { key } of fields) next[key] = asText(from[key]);
  return next;
}

export interface SspProfileFormProps {
  /** The form's accessible name. */
  title: string;
  /** Which `SSP_PROFILE_FIELDS` groups it edits. */
  groups: readonly SspProfileGroup[];
  profile: SspProfile;
  /** Called with the profile as stored after a save. */
  onSaved: (profile: SspProfile) => void;
}

/**
 * Part of the SSP profile: one control per field in `groups`, in contract order, and a Save
 * that PATCHes `/api/ssp/profile` with only the keys that changed.
 */
export function SspProfileForm({ title, groups, profile, onSaved }: SspProfileFormProps) {
  const fields = SSP_PROFILE_FIELDS.filter((field) => groups.includes(field.group));
  const hintId = useId();
  const [saved, setSaved] = useState(profile);
  const [draft, setDraft] = useState<Draft>(() => toDraft(fields, profile));
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [pending, setPending] = useState(false);

  const textOf = (key: SspProfileFieldKey) => draft[key] ?? '';
  const dirtyKeys = fields
    .map(({ key }) => key)
    .filter((key) => {
      const parsed = parseSspField(key, textOf(key));
      // An invalid value is a change when its text differs from what is stored.
      return parsed.ok
        ? effective(key, parsed.value) !== effective(key, saved[key])
        : textOf(key) !== asText(saved[key]);
    });

  function edit(key: SspProfileFieldKey, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setJustSaved(false);
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || dirtyKeys.length === 0) return;
    const found: Errors = {};
    const patch: Record<string, Value> = {};
    for (const key of dirtyKeys) {
      const parsed = parseSspField(key, textOf(key));
      if (parsed.ok) patch[key] = parsed.value;
      else found[key] = parsed.message;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    setJustSaved(false);
    setPending(true);
    try {
      const { profile: stored } = await apiSend(
        'PATCH',
        '/api/ssp/profile',
        patch,
        sspProfileResponseSchema,
      );
      setSaved(stored);
      setDraft(toDraft(fields, stored));
      setJustSaved(true);
      onSaved(stored);
    } catch (caught) {
      const byField = fieldErrors(caught);
      const own = Object.keys(byField).filter((key) => fields.some((f) => f.key === key));
      if (own.length > 0) setErrors(byField);
      else setFailure(errorText(caught, SAVE_FAILED));
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
      aria-label={title}
      noValidate
      onSubmit={(event) => void onSubmit(event)}
    >
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      {fields.map(({ key, label }) => {
        const common = {
          label,
          value: textOf(key),
          error: errors[key],
        };
        if (LONG_SSP_FIELDS.has(key)) {
          return (
            <TextArea
              key={key}
              {...common}
              onChange={(event) => {
                edit(key, event.target.value);
              }}
            />
          );
        }
        const isDate = key === 'nextReviewDate';
        return (
          <div key={key} className={styles.field}>
            <TextField
              {...common}
              type={key === 'securityOfficerEmail' ? 'email' : 'text'}
              inputMode={key === 'reviewCadenceMonths' ? 'numeric' : undefined}
              placeholder={isDate ? 'YYYY-MM-DD' : undefined}
              aria-describedby={isDate ? hintId : undefined}
              autoComplete="off"
              onChange={(event) => {
                edit(key, event.target.value);
              }}
            />
            {isDate && (
              <p id={hintId} className={styles.hint}>
                YYYY-MM-DD
              </p>
            )}
          </div>
        );
      })}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={pending || dirtyKeys.length === 0}>
          Save
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
