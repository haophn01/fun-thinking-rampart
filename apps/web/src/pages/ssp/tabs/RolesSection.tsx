import {
  createSystemRoleRequestSchema,
  patchSystemRoleRequestSchema,
  roleResponseSchema,
  rolesResponseSchema,
  type SystemRole,
} from '@rampart/api/contract';
import { useState, type SyntheticEvent } from 'react';
import { ApiError, apiSend } from '../../../api/client';
import { Alert, Button, Checkbox, TextArea, TextField } from '../../../look';
import {
  LoadError,
  RemoveButton,
  Section,
  SspTable,
  errorText,
  fieldErrors,
  useLoad,
} from '../kit';
import styles from './identification.module.css';

const TITLE_MESSAGE = 'Enter a role title';
const USERS_MESSAGE = 'Enter a whole number from 0 to 1,000,000';
const SAVE_FAILED = "Couldn't save the role. Try again.";
const REMOVE_FAILED = "Couldn't remove the role. Try again.";

interface Draft {
  title: string;
  person: string;
  responsibilities: string;
  userCount: string;
  privileged: boolean;
}
type Errors = Partial<Record<'title' | 'person' | 'responsibilities' | 'userCount', string>>;

const BLANK: Draft = {
  title: '',
  person: '',
  responsibilities: '',
  userCount: '0',
  privileged: false,
};

function toDraft(role: SystemRole): Draft {
  return {
    title: role.title,
    person: role.person ?? '',
    responsibilities: role.responsibilities ?? '',
    userCount: String(role.userCount),
    privileged: role.privileged,
  };
}

/** A draft as the values it would send, or the message for each bad field. */
function parse(draft: Draft): { values: CreateValues } | { errors: Errors } {
  const errors: Errors = {};
  const title = draft.title.trim();
  if (title === '') errors.title = TITLE_MESSAGE;
  const countText = draft.userCount.trim();
  const userCount = /^\d+$/.test(countText) ? Number(countText) : -1;
  if (userCount < 0 || userCount > 1_000_000) errors.userCount = USERS_MESSAGE;
  const person = draft.person.trim();
  const responsibilities = draft.responsibilities.trim();
  if (Object.keys(errors).length > 0) return { errors };
  return {
    values: {
      title,
      person: person === '' ? null : person,
      responsibilities: responsibilities === '' ? null : responsibilities,
      userCount,
      privileged: draft.privileged,
    },
  };
}
interface CreateValues {
  title: string;
  person: string | null;
  responsibilities: string | null;
  userCount: number;
  privileged: boolean;
}

/** The keys of `values` that differ from the stored role. */
function changedKeys(values: CreateValues, role: SystemRole): Partial<CreateValues> {
  const patch: Partial<CreateValues> = {};
  if (values.title !== role.title) patch.title = values.title;
  if (values.person !== role.person) patch.person = values.person;
  if (values.responsibilities !== role.responsibilities) {
    patch.responsibilities = values.responsibilities;
  }
  if (values.userCount !== role.userCount) patch.userCount = values.userCount;
  if (values.privileged !== role.privileged) patch.privileged = values.privileged;
  return patch;
}

interface RoleFormProps {
  /** The role being edited; `null` adds one. */
  role: SystemRole | null;
  onDone: () => void;
  onCancel: () => void;
  onMissing: (error: unknown) => void;
}

function RoleForm({ role, onDone, onCancel, onMissing }: RoleFormProps) {
  const [draft, setDraft] = useState<Draft>(role === null ? BLANK : toDraft(role));
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const parsed = parse(draft);
  const unchanged =
    role !== null &&
    'values' in parsed &&
    Object.keys(changedKeys(parsed.values, role)).length === 0;

  function edit(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors({});
    setFailure(null);
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if ('errors' in parsed) {
      setErrors(parsed.errors);
      return;
    }
    if (role !== null && unchanged) return;
    setPending(true);
    setFailure(null);
    try {
      if (role === null) {
        const body = createSystemRoleRequestSchema.parse(parsed.values);
        await apiSend('POST', '/api/ssp/roles', body, roleResponseSchema);
      } else {
        const body = patchSystemRoleRequestSchema.parse(changedKeys(parsed.values, role));
        await apiSend('PATCH', `/api/ssp/roles/${role.id}`, body, roleResponseSchema);
      }
      onDone();
    } catch (caught) {
      const byField = fieldErrors(caught);
      if (Object.keys(byField).length > 0) setErrors(byField);
      else if (role !== null && isNotFound(caught)) onMissing(caught);
      else setFailure(errorText(caught, SAVE_FAILED));
    } finally {
      setPending(false);
    }
  }

  const adding = role === null;
  return (
    <form
      className={styles.form}
      aria-label={adding ? 'Add role' : 'Edit role'}
      noValidate
      onSubmit={(event) => void onSubmit(event)}
    >
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <TextField
        label="Title"
        value={draft.title}
        error={errors.title}
        autoComplete="off"
        onChange={(event) => {
          edit({ title: event.target.value });
        }}
      />
      <TextField
        label="Person"
        value={draft.person}
        error={errors.person}
        autoComplete="off"
        onChange={(event) => {
          edit({ person: event.target.value });
        }}
      />
      <TextArea
        label="Responsibilities"
        value={draft.responsibilities}
        error={errors.responsibilities}
        onChange={(event) => {
          edit({ responsibilities: event.target.value });
        }}
      />
      <TextField
        label="Number of users"
        value={draft.userCount}
        error={errors.userCount}
        inputMode="numeric"
        autoComplete="off"
        onChange={(event) => {
          edit({ userCount: event.target.value });
        }}
      />
      <Checkbox
        label="Privileged"
        checked={draft.privileged}
        onChange={(checked) => {
          edit({ privileged: checked });
        }}
      />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={pending || unchanged}>
          {adding ? 'Add role' : 'Save role'}
        </Button>
        {!adding && (
          <Button onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'not_found';
}

/** Roles: who uses the system, how many are privileged. Add, edit and remove. */
export function RolesSection({ number }: { number: number }) {
  const roles = useLoad('/api/ssp/roles', rolesResponseSchema);
  const [editing, setEditing] = useState<SystemRole | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped after each save so the next add starts from a blank form.
  const [saves, setSaves] = useState(0);

  async function reload() {
    await roles.reload();
  }

  async function remove(role: SystemRole) {
    setNotice(null);
    try {
      await apiSend('DELETE', `/api/ssp/roles/${role.id}`);
      if (editing?.id === role.id) setEditing(null);
    } catch (caught) {
      setNotice(errorText(caught, REMOVE_FAILED));
      if (!isNotFound(caught)) return;
      if (editing?.id === role.id) setEditing(null);
    }
    await reload();
  }

  const view = roles.data;
  let body;
  if (view !== null) {
    body = (
      <>
        <p className={styles.totals}>
          {`${String(view.totals.users)} users · ${String(view.totals.privilegedUsers)} privileged`}
        </p>
        <p className={styles.hint}>
          The SSP&apos;s privileged and admin count comes from this table.
        </p>
        {notice !== null && <Alert tone="error">{notice}</Alert>}
        <SspTable
          caption="System roles"
          empty="No roles yet."
          rows={view.roles}
          rowKey={(role) => role.id}
          columns={[
            { header: 'Role', cell: (role) => role.title },
            { header: 'Person', cell: (role) => role.person ?? '' },
            { header: 'Responsibilities', cell: (role) => role.responsibilities ?? '' },
            { header: 'Users', cell: (role) => String(role.userCount) },
            { header: 'Privileged', cell: (role) => (role.privileged ? 'Yes' : 'No') },
            {
              header: 'Actions',
              cell: (role) => (
                <span className={styles.rowActions}>
                  <Button
                    onClick={() => {
                      setNotice(null);
                      setEditing(role);
                    }}
                  >
                    Edit
                  </Button>
                  <RemoveButton
                    name={role.title}
                    onConfirm={() => {
                      return remove(role);
                    }}
                  />
                </span>
              ),
            },
          ]}
        />
        <div className={styles.formBlock}>
          <RoleForm
            // A fresh form per role being edited, and per add, so a draft never leaks across.
            key={editing === null ? `add-${String(saves)}` : editing.id}
            role={editing}
            onCancel={() => {
              setEditing(null);
            }}
            onDone={() => {
              setNotice(null);
              setEditing(null);
              setSaves((n) => n + 1);
              void reload();
            }}
            onMissing={(error) => {
              setNotice(errorText(error, SAVE_FAILED));
              setEditing(null);
              void reload();
            }}
          />
        </div>
      </>
    );
  } else if (roles.failed) {
    body = (
      <LoadError
        title="Can't load the roles"
        onRetry={() => {
          void roles.reload();
        }}
      />
    );
  } else {
    body = <p className={styles.muted}>Loading the roles…</p>;
  }

  return (
    <Section number={number} title="Roles">
      {body}
    </Section>
  );
}
