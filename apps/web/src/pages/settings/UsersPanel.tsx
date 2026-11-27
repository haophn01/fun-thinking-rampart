import {
  createUserRequestSchema,
  displayNameSchema,
  emailSchema,
  passwordSchema,
  roleSchema,
  userResponseSchema,
  usersResponseSchema,
  type Role,
  type UpdateUserRequest,
  type User,
} from '@rampart/api/contract';
import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { ApiError, apiGet, apiSend } from '../../api/client';
import { ROLE_LABELS, useSession } from '../../auth/session';
import { Alert, Button, Select, TextField } from '../../look';
import styles from './settings.module.css';

const PASSWORD_RULE = 'Use 12 to 128 characters.';
const TOO_COMMON = 'This password is too common. Choose another.';
const TEMP_HINT = 'They choose their own at first sign-in.';
const EMAIL_TAKEN = 'That email is already in use.';
const ROLES = roleSchema.options;

/** The Alert text for a failed user change. */
function changeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'last_admin':
        return 'Keep at least one active admin. Make someone else an admin first.';
      case 'forbidden':
        return 'Only admins can change users.';
      case 'csrf_failed':
        return 'The security check failed. Reload the page and try again.';
      case 'not_found':
        return 'That user no longer exists. Reload the page.';
      case 'network_error':
        return "Can't reach the API. Check your connection and try again.";
      case 'validation_failed':
        return 'The change was not accepted. Check the fields and try again.';
    }
  }
  return "Couldn't save the change. Try again.";
}

function RoleOptions() {
  return ROLES.map((role) => (
    <option key={role} value={role}>
      {ROLE_LABELS[role]}
    </option>
  ));
}

interface CreateFormProps {
  /** Called as a valid add is sent, so the panel can clear an old message. */
  onSubmitting: () => void;
  onCreated: (user: User) => Promise<void>;
}

type CreateField = 'email' | 'displayName' | 'password';
const EMPTY = { email: '', displayName: '', role: 'contributor' as Role, password: '' };

function CreateUserForm({ onSubmitting, onCreated }: CreateFormProps) {
  const headingId = useId();
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<CreateField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const next: Partial<Record<CreateField, string>> = {};
    if (!emailSchema.safeParse(values.email).success) next.email = 'Enter a valid email address.';
    if (!displayNameSchema.safeParse(values.displayName).success) {
      next.displayName = 'Enter a name of 1 to 80 characters.';
    }
    if (!passwordSchema.safeParse(values.password).success) next.password = PASSWORD_RULE;
    setErrors(next);
    const body = createUserRequestSchema.safeParse(values);
    if (Object.keys(next).length > 0 || !body.success) return;

    setPending(true);
    setFailure(null);
    onSubmitting();
    try {
      const { user } = await apiSend('POST', '/api/users', body.data, userResponseSchema);
      setValues(EMPTY);
      await onCreated(user);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'email_taken') {
        setErrors({ email: EMAIL_TAKEN });
      } else if (error instanceof ApiError && error.code === 'password_too_common') {
        setErrors({ password: TOO_COMMON });
      } else {
        setFailure(changeFailure(error));
      }
    } finally {
      setPending(false);
    }
  }

  const text = (name: CreateField) => ({
    value: values[name],
    error: errors[name],
    onChange: (event: { target: { value: string } }) => {
      const value = event.target.value;
      setValues((current) => ({ ...current, [name]: value }));
    },
  });

  return (
    <form
      className={styles.create}
      aria-labelledby={headingId}
      noValidate
      onSubmit={(event) => void onSubmit(event)}
    >
      <h3 id={headingId}>Add a user</h3>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <div className={styles.fields}>
        <TextField label="Email" type="email" autoComplete="off" {...text('email')} />
        <TextField label="Display name" autoComplete="off" {...text('displayName')} />
        <Select
          label="Role"
          value={values.role}
          onChange={(event) => {
            const role = roleSchema.parse(event.target.value);
            setValues((current) => ({ ...current, role }));
          }}
        >
          <RoleOptions />
        </Select>
        <TextField
          label="Temporary password"
          type="password"
          autoComplete="new-password"
          {...text('password')}
        />
      </div>
      <p className={styles.muted}>{TEMP_HINT}</p>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Adding…' : 'Add user'}
        </Button>
      </div>
    </form>
  );
}

interface UserRowProps {
  user: User;
  isMe: boolean;
  busy: boolean;
  /** Resolves true when saved, 'too_common' when the new password was refused, else false. */
  onChange: (user: User, change: UpdateUserRequest) => Promise<boolean | 'too_common'>;
}

function UserRow({ user, isMe, busy, onChange }: UserRowProps) {
  const nameId = useId();
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | undefined>();

  async function savePassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passwordSchema.safeParse(password).success) {
      setPasswordError(PASSWORD_RULE);
      return;
    }
    setPasswordError(undefined);
    const saved = await onChange(user, { password });
    if (saved === 'too_common') setPasswordError(TOO_COMMON);
    else if (saved) {
      setResetting(false);
      setPassword('');
    }
  }

  return (
    <li className={styles.row} aria-labelledby={nameId} data-active={user.active}>
      <div className={styles.identity}>
        <span className={styles.nameLine}>
          <span id={nameId} className={styles.name}>
            {user.displayName}
          </span>
          {isMe && <span className={styles.tag}>You</span>}
        </span>
        <span className={styles.email}>{user.email}</span>
      </div>
      <span className={styles.state}>{user.active ? 'Active' : 'Inactive'}</span>
      <Select
        label="Role"
        value={user.role}
        disabled={busy}
        onChange={(event) => {
          void onChange(user, { role: roleSchema.parse(event.target.value) });
        }}
      >
        <RoleOptions />
      </Select>
      <div className={styles.actions}>
        <Button disabled={busy} onClick={() => void onChange(user, { active: !user.active })}>
          {user.active ? 'Deactivate' : 'Reactivate'}
        </Button>
        <Button
          disabled={busy}
          aria-expanded={resetting}
          onClick={() => {
            setResetting((value) => !value);
            setPassword('');
            setPasswordError(undefined);
          }}
        >
          Reset password
        </Button>
      </div>
      {resetting && (
        <form className={styles.reset} noValidate onSubmit={(event) => void savePassword(event)}>
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            error={passwordError}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          <div className={styles.actions}>
            <Button type="submit" disabled={busy}>
              Save password
            </Button>
            <Button
              onClick={() => {
                setResetting(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

/** Admin-only user management: list, add, change role, deactivate or reactivate, reset password. */
export function UsersPanel() {
  const session = useSession();
  const meId = session.user?.id;
  const [users, setUsers] = useState<User[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Each load bumps this; an answer from an older load (or after unmount) is dropped.
  const latest = useRef(0);
  const load = useCallback(async () => {
    latest.current += 1;
    const run = latest.current;
    const list = await apiGet('/api/users', usersResponseSchema).then(
      (body) => body.users,
      () => null,
    );
    if (run !== latest.current) return;
    // The list stays as it was when a reload fails; only a first load shows the error.
    if (list !== null) setUsers(list);
    setLoadFailed(list === null);
  }, []);

  useEffect(() => {
    // load() sets state only after its request answers, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  const change = useCallback(
    async (target: User, update: UpdateUserRequest): Promise<boolean | 'too_common'> => {
      setBusyId(target.id);
      setFailure(null);
      setNotice(null);
      try {
        const { user } = await apiSend(
          'PATCH',
          `/api/users/${encodeURIComponent(target.id)}`,
          update,
          userResponseSchema,
        );
        setUsers((list) => list?.map((u) => (u.id === user.id ? user : u)) ?? null);
        if (update.password !== undefined) {
          setNotice(
            `Password reset for ${user.displayName}. Their sessions have ended, and they must choose a new password at next sign-in.`,
          );
        }
        // A new password, deactivation or role change ends your own sessions.
        if (
          target.id === meId &&
          (update.password !== undefined || update.active === false || update.role !== undefined)
        ) {
          session.endSession();
        }
        return true;
      } catch (error) {
        if (
          update.password !== undefined &&
          error instanceof ApiError &&
          error.code === 'password_too_common'
        ) {
          return 'too_common';
        }
        setFailure(changeFailure(error));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [meId, session],
  );

  const clearMessages = useCallback(() => {
    setFailure(null);
    setNotice(null);
  }, []);

  const created = useCallback(
    async (user: User) => {
      setFailure(null);
      setNotice(`Added ${user.displayName}.`);
      await load();
    },
    [load],
  );

  if (loadFailed && users === null) {
    return (
      <Alert tone="error" title="Can't load users">
        <p>Check that the API is running, then retry.</p>
        <Button
          className={styles.retry}
          onClick={() => {
            void load();
          }}
        >
          Retry
        </Button>
      </Alert>
    );
  }
  if (users === null) return <p className={styles.muted}>Loading users…</p>;

  return (
    <div className={styles.panel}>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      {notice !== null && <Alert tone="info">{notice}</Alert>}
      <ul className={styles.list}>
        {users.map((user) => (
          <UserRow
            key={user.id}
            user={user}
            isMe={user.id === meId}
            busy={busyId === user.id}
            onChange={change}
          />
        ))}
      </ul>
      <CreateUserForm onSubmitting={clearMessages} onCreated={created} />
    </div>
  );
}
