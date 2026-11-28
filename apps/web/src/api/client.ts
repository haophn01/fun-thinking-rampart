import {
  CSRF_HEADER,
  FILE_NAME_HEADER,
  UPLOAD_EXTENSIONS,
  errorEnvelopeSchema,
  uploadProblem,
  type UploadProblem,
} from '@rampart/api/contract';

/** `network_error` and `invalid_response` come from the client; every other code is the api's. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  /** The envelope's `details`, such as `{ retryAfterSeconds }` on `too_many_attempts`. */
  readonly details?: unknown;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    requestId?: string | undefined;
    details?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.details !== undefined) this.details = init.details;
  }
}

/** What `apiGet` and `apiSend` need from a contract schema (zod's `safeParse` fits). */
export interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

export type SendMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** How the client reaches the session store. The session provider registers them. */
export interface ApiSessionHooks {
  /** The current session's CSRF token, or `null` when signed out. */
  csrfToken: () => string | null;
  /**
   * Called on a 401 from any call except sign-in and setup, unless its code is
   * `invalid_credentials` (a wrong password on unlock or change) or `invalid_mfa_code` (a wrong
   * two-step code): those are refusals, not an ended session.
   */
  onUnauthenticated: () => void;
  /** Called on a 423 `session_locked` from any call. */
  onLocked: () => void;
  /** Called on a 403 `mfa_required` from any call: the session still needs two-step sign-in. */
  onMfaRequired: () => void;
}

let sessionHooks: ApiSessionHooks | null = null;

/** Registers (or, with `null`, removes) the session store's hooks. */
export function setApiSessionHooks(hooks: ApiSessionHooks | null): void {
  sessionHooks = hooks;
}

/** A 401 from these means the credentials were wrong, not that a session ended. */
const CREDENTIAL_CALLS = new Set(['POST /api/session', 'POST /api/setup']);

/** 401 codes that refuse what was typed, and leave the session as it was. */
const REFUSAL_CODES = new Set(['invalid_credentials', 'invalid_mfa_code']);

/** Tells the session store that a call found its session ended, locked or awaiting MFA. */
function runSessionHooks(status: number, code: string | undefined, call: string): void {
  if (status === 423 && code === 'session_locked') sessionHooks?.onLocked();
  if (status === 403 && code === 'mfa_required') sessionHooks?.onMfaRequired();
  const refusal = code !== undefined && REFUSAL_CODES.has(code);
  if (status === 401 && !refusal && !CREDENTIAL_CALLS.has(call)) {
    sessionHooks?.onUnauthenticated();
  }
}

async function readJson(response: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: (await response.json()) as unknown };
  } catch {
    return { ok: false };
  }
}

async function request<T>(
  method: 'GET' | SendMethod,
  path: string,
  init: RequestInit,
  schema: ResponseSchema<T> | undefined,
): Promise<T | undefined> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: 'The request could not reach the API.',
    });
  }

  if (response.status === 204) return undefined;

  const body = await readJson(response);
  const invalid = (message: string) =>
    new ApiError({ status: response.status, code: 'invalid_response', message });

  if (!response.ok) {
    const envelope = body.ok ? errorEnvelopeSchema.safeParse(body.value) : undefined;
    runSessionHooks(
      response.status,
      envelope?.success ? envelope.data.error.code : undefined,
      `${method} ${path}`,
    );
    if (envelope?.success) {
      const { code, message, requestId, details } = envelope.data.error;
      throw new ApiError({ status: response.status, code, message, requestId, details });
    }
    throw invalid(`The API answered ${String(response.status)} without an error envelope.`);
  }

  if (schema === undefined) return undefined;
  if (!body.ok) throw invalid('The API response was not JSON.');
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) throw invalid('The API response did not match its contract.');
  return parsed.data;
}

/** GET a path from the api and parse the body with its contract schema. Throws `ApiError`. */
export async function apiGet<T>(path: string, schema: ResponseSchema<T>): Promise<T> {
  return (await request('GET', path, { headers: { accept: 'application/json' } }, schema)) as T;
}

/**
 * Send a write to the api: a JSON body (when given) and the session's CSRF token. A 204, or a
 * call without a schema, resolves to `undefined`; pass a schema only for routes that answer with
 * a body. Throws `ApiError`.
 */
export function apiSend<T>(
  method: SendMethod,
  path: string,
  body: unknown,
  schema: ResponseSchema<T>,
): Promise<T>;
export function apiSend(method: SendMethod, path: string, body?: unknown): Promise<undefined>;
export async function apiSend<T>(
  method: SendMethod,
  path: string,
  body?: unknown,
  schema?: ResponseSchema<T>,
): Promise<T | undefined> {
  const headers = new Headers({ accept: 'application/json' });
  const token = sessionHooks?.csrfToken() ?? null;
  if (token !== null) headers.set(CSRF_HEADER, token);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(body);
  }
  return request(method, path, init, schema);
}

const UPLOAD_PROBLEMS: Record<UploadProblem, { code: string; message: string }> = {
  invalid_file_name: {
    code: 'validation_failed',
    message: "The file name isn't valid. Rename the file and try again.",
  },
  unsupported_file_type: {
    code: 'unsupported_file_type',
    message: `This file type can't be uploaded. Allowed: ${UPLOAD_EXTENSIONS.join(' ')}`,
  },
  empty: { code: 'validation_failed', message: 'The file is empty.' },
  too_large: { code: 'payload_too_large', message: 'The file is larger than 25 MiB.' },
};

/**
 * Upload a file to the api: POSTs its bytes as `application/octet-stream`, with its name in
 * `FILE_NAME_HEADER` and the session's CSRF token, and parses the answer like `apiSend`. A file
 * `uploadProblem` refuses is never sent: it throws `ApiError` with status 0 and the code the api
 * would give (`payload_too_large`, `unsupported_file_type` or `validation_failed`), with
 * `details.problem`.
 */
export async function apiUpload<T>(
  path: string,
  file: Blob,
  fileName: string,
  schema: ResponseSchema<T>,
): Promise<T> {
  const problem = uploadProblem(fileName, file.size);
  if (problem !== null) {
    const { code, message } = UPLOAD_PROBLEMS[problem];
    throw new ApiError({
      status: 0,
      code,
      message,
      details:
        problem === 'unsupported_file_type'
          ? { problem, allowed: [...UPLOAD_EXTENSIONS] }
          : { problem },
    });
  }

  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/octet-stream',
    [FILE_NAME_HEADER]: encodeURIComponent(fileName),
  });
  const token = sessionHooks?.csrfToken() ?? null;
  if (token !== null) headers.set(CSRF_HEADER, token);
  return (await request('POST', path, { method: 'POST', headers, body: file }, schema)) as T;
}
