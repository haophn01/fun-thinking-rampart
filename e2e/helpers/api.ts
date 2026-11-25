// Calls the api as the signed-in browser user: `page.request` shares the page's cookie jar, and
// every write carries the session's CSRF token, the same way the web app sends it.
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import {
  CSRF_HEADER,
  FILE_NAME_HEADER,
  sessionResponseSchema,
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

  const send = (method: Method, path: string, body?: unknown) =>
    request.fetch(path, {
      method,
      headers: { ...csrf, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { data: JSON.stringify(body) }),
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
