import { CSRF_HEADER, errorEnvelopeSchema } from '@rampart/api/contract';

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
  /** Called on a 401 from any call except sign-in and setup. */
  onUnauthenticated: () => void;
}

let sessionHooks: ApiSessionHooks | null = null;

/** Registers (or, with `null`, removes) the session store's hooks. */
export function setApiSessionHooks(hooks: ApiSessionHooks | null): void {
  sessionHooks = hooks;
}

/** A 401 from these means the credentials were wrong, not that a session ended. */
const CREDENTIAL_CALLS = new Set(['POST /api/session', 'POST /api/setup']);

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

  if (response.status === 401 && !CREDENTIAL_CALLS.has(`${method} ${path}`)) {
    sessionHooks?.onUnauthenticated();
  }
  if (response.status === 204) return undefined;

  const body = await readJson(response);
  const invalid = (message: string) =>
    new ApiError({ status: response.status, code: 'invalid_response', message });

  if (!response.ok) {
    const envelope = body.ok ? errorEnvelopeSchema.safeParse(body.value) : undefined;
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
