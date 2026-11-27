// Calls the api as the signed-in browser user: `page.request` shares the page's cookie jar, and
// every write carries the session's CSRF token, the same way the web app sends it.
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { base32Decode } from '../../apps/api/src/auth/mfa/base32.ts';
import { totpAt, totpStep } from '../../apps/api/src/auth/mfa/totp.ts';
import {
  CSRF_HEADER,
  FILE_NAME_HEADER,
  TOTP_PERIOD_SECONDS,
  diagramResponseSchema,
  evidenceItemResponseSchema,
  mfaEnrolledResponseSchema,
  mfaEnrollmentResponseSchema,
  sessionResponseSchema,
  type DiagramKind,
  type DiagramLink,
  type EvidenceItem,
  type SessionResponse,
} from '../../apps/api/src/contract/index.ts';

type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What a contract schema offers (zod's `parse` fits). */
interface Schema<T> {
  parse(data: unknown): T;
}

export interface Api {
  /** The raw response, for specs that check a status or a refusal. */
  get(path: string): Promise<APIResponse>;
  send(method: Method, path: string, body?: unknown): Promise<APIResponse>;
  /** A raw `application/octet-stream` upload, its name in `FILE_NAME_HEADER`. */
  upload(path: string, fileName: string, bytes: Uint8Array): Promise<APIResponse>;
  /** A GET that must succeed, parsed with the contract's schema. */
  read<T>(path: string, schema: Schema<T>): Promise<T>;
  /** A write that must succeed, parsed with the contract's schema. */
  write<T>(method: Method, path: string, body: unknown, schema: Schema<T>): Promise<T>;
}

const STEP_MS = TOTP_PERIOD_SECONDS * 1000;
/** The newest TOTP step this run used for each secret, so no code is ever sent twice. */
const usedSteps = new Map<string, number>();

/** The manual key as the enrollment page shows it (groups of 4), as the base32 secret. */
export function manualKey(shown: string): string {
  return shown.replace(/\s+/g, '');
}

/**
 * A code for `secret` (base32) the api will take: never a step this run already used for it. The
 * current step's code, else the next step's (inside the api's window of one step), else it waits
 * for the next step to start. Codes typed in the browser come from here too.
 */
export async function nextTotpCode(secret: string): Promise<string> {
  const key = base32Decode(secret);
  for (;;) {
    const now = new Date();
    const step = totpStep(now);
    const last = usedSteps.get(secret) ?? -1;
    const use = step > last ? step : step + 1 > last ? step + 1 : null;
    if (use !== null) {
      usedSteps.set(secret, use);
      return totpAt(key, new Date(use * STEP_MS));
    }
    await new Promise((done) => setTimeout(done, STEP_MS - (now.getTime() % STEP_MS) + 50));
  }
}

/** A session after its MFA step, with what the step used or handed out. */
export type SignedIn = SessionResponse & {
  /** The account's TOTP secret (base32): the one given, or the one enrollment just made. */
  totpSecret: string | null;
  /** The recovery codes enrollment just showed; empty when the session only verified. */
  recoveryCodes: string[];
};

export interface SignInOptions {
  /** The enrolled account's secret (base32), for the challenge. */
  totpSecret?: string;
  /** `password_only`: stop after the password, leaving the session as sign-in made it. */
  mfa?: 'password_only';
}

/**
 * Finishes the session's MFA step as it asks: `enroll` enrolls (and returns the new secret and
 * the recovery codes), `challenge` verifies with `totpSecret`, `none` is left alone.
 */
export async function completeMfa(
  request: APIRequestContext,
  session: SessionResponse,
  totpSecret: string | null = null,
): Promise<SignedIn> {
  if (session.mfa === 'none') return { ...session, totpSecret, recoveryCodes: [] };
  const headers = { [CSRF_HEADER]: session.csrfToken ?? '' };
  if (session.mfa === 'enroll') {
    const started = await ensureOk(
      await request.post('/api/session/mfa/enroll', { headers }),
      'POST /api/session/mfa/enroll',
    );
    const { secret } = mfaEnrollmentResponseSchema.parse(await started.json());
    const confirmed = await ensureOk(
      await request.post('/api/session/mfa/enroll/confirm', {
        headers,
        data: { code: await nextTotpCode(secret) },
      }),
      'POST /api/session/mfa/enroll/confirm',
    );
    const { recoveryCodes, ...rest } = mfaEnrolledResponseSchema.parse(await confirmed.json());
    return { ...rest, totpSecret: secret, recoveryCodes };
  }
  if (totpSecret === null) throw new Error('The session asks for a code: pass its totpSecret.');
  const verified = await ensureOk(
    await request.post('/api/session/mfa/verify', {
      headers,
      data: { code: await nextTotpCode(totpSecret) },
    }),
    'POST /api/session/mfa/verify',
  );
  return { ...sessionResponseSchema.parse(await verified.json()), totpSecret, recoveryCodes: [] };
}

/**
 * Signs `request` in as the given user, acknowledging the sign-in notice when one is set (its
 * digest comes from `GET /api/session`, as the web app's does), then finishes the MFA step as
 * `completeMfa` does, unless `{ mfa: 'password_only' }`.
 */
export async function signIn(
  request: APIRequestContext,
  email: string,
  password: string,
  options: SignInOptions = {},
): Promise<SignedIn> {
  const before = sessionResponseSchema.parse(
    await (await ensureOk(await request.get('/api/session'), 'GET /api/session')).json(),
  );
  const noticeDigest = before.signInNotice?.digest;
  const response = await request.post('/api/session', {
    data: { email, password, ...(noticeDigest === undefined ? {} : { noticeDigest }) },
  });
  const session = sessionResponseSchema.parse(
    await (await ensureOk(response, `sign in ${email}`)).json(),
  );
  const totpSecret = options.totpSecret ?? null;
  if (options.mfa === 'password_only') return { ...session, totpSecret, recoveryCodes: [] };
  return completeMfa(request, session, totpSecret);
}

/** First-run setup through the api, then enrollment: the admin's full session and its secret. */
export async function setUp(
  request: APIRequestContext,
  admin: { email: string; displayName: string; password: string },
): Promise<SignedIn> {
  const response = await ensureOk(await request.post('/api/setup', { data: admin }), 'setup');
  return completeMfa(request, sessionResponseSchema.parse(await response.json()));
}

/** Throws with the status and body when a response isn't 2xx, so a failure says why. */
export async function ensureOk(response: APIResponse, what: string): Promise<APIResponse> {
  if (!response.ok()) {
    throw new Error(`${what} answered ${String(response.status())}: ${await response.text()}`);
  }
  return response;
}

/**
 * An api client for the user the page (or request context) is signed in as. It reads the CSRF
 * token from `GET /api/session` once; make a new one after signing in again.
 */
export async function api(target: Page | APIRequestContext): Promise<Api> {
  const request = 'request' in target ? target.request : target;
  const session = sessionResponseSchema.parse(
    await (await ensureOk(await request.get('/api/session'), 'GET /api/session')).json(),
  );
  if (session.user === null || session.csrfToken === null) {
    throw new Error('api(page) needs a signed-in page');
  }
  const csrf = { [CSRF_HEADER]: session.csrfToken };

  // No body, no JSON content type: the api refuses an empty JSON body.
  const send = (method: Method, path: string, body?: unknown) =>
    request.fetch(path, {
      method,
      ...(body === undefined
        ? { headers: csrf }
        : { headers: { ...csrf, 'content-type': 'application/json' }, data: JSON.stringify(body) }),
    });

  return {
    get: (path) => request.get(path),
    send,
    upload: (path, fileName, bytes) =>
      request.post(path, {
        headers: {
          ...csrf,
          'content-type': 'application/octet-stream',
          [FILE_NAME_HEADER]: encodeURIComponent(fileName),
        },
        data: Buffer.from(bytes),
      }),
    read: async (path, schema) =>
      schema.parse(await (await ensureOk(await request.get(path), `GET ${path}`)).json()),
    write: async (method, path, body, schema) =>
      schema.parse(
        await (await ensureOk(await send(method, path, body), `${method} ${path}`)).json(),
      ),
  };
}

/** A new evidence item (not flagged CUI) holding one uploaded file; the item as the upload left it. */
export async function uploadEvidence(
  client: Api,
  evidence: { title: string; fileName: string; bytes: Uint8Array; description?: string },
): Promise<EvidenceItem> {
  const { item } = await client.write(
    'POST',
    '/api/evidence',
    {
      title: evidence.title,
      description: evidence.description ?? null,
      containsCui: false,
      objectiveIds: [],
    },
    evidenceItemResponseSchema,
  );
  const response = await ensureOk(
    await client.upload(`/api/evidence/${item.id}/versions`, evidence.fileName, evidence.bytes),
    `upload ${evidence.fileName}`,
  );
  return evidenceItemResponseSchema.parse(await response.json()).item;
}

/** Links an evidence item as an SSP diagram that always follows its newest version. */
export async function linkDiagram(
  client: Api,
  evidenceId: string,
  kind: DiagramKind,
  caption: string,
): Promise<DiagramLink> {
  const { diagram } = await client.write(
    'POST',
    '/api/ssp/diagrams',
    { evidenceId, kind, caption, version: null },
    diagramResponseSchema,
  );
  return diagram;
}
