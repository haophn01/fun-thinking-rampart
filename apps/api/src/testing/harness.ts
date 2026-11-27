import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { openDb, runMigrations, type AppDb, type DbHandle } from '../../db/client';
import { user } from '../../db/schema';
import { createMemoryStore, type MemoryFileStore } from '../../storage';
import { buildApp } from '../app';
import { sessionCookieName } from '../auth/cookie';
import { loadConfig, type Config, type LogLevel } from '../config';
import { CSRF_HEADER, sessionResponseSchema, type SessionUser } from '../contract';

/** The admin `setupAdmin()` creates unless told otherwise. */
export const ADMIN = {
  email: 'admin@example.com',
  displayName: 'Ada Admin',
  password: 'correct horse battery',
} as const;

/** Where every harness clock starts. */
export const START = new Date('2026-11-23T09:00:00.000Z');

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  /** Sent as JSON with `content-type: application/json`. */
  body?: unknown;
  /**
   * Sent exactly as given, with no content type of its own: set one in `headers`. Wins over
   * `body`, for sending any bytes with any content type.
   */
  rawBody?: string | Uint8Array;
  /** Extra headers; `null` removes one the client would send (e.g. the CSRF header). */
  headers?: Record<string, string | null>;
}

/**
 * A browser stand-in: it keeps the session cookie the api sets and sends the CSRF token it was
 * given on every request, as the web app does.
 */
export interface Client {
  request(method: Method, url: string, options?: RequestOptions): Promise<LightMyRequestResponse>;
  get(url: string, options?: RequestOptions): Promise<LightMyRequestResponse>;
  post(url: string, body?: unknown, options?: RequestOptions): Promise<LightMyRequestResponse>;
  put(url: string, body?: unknown, options?: RequestOptions): Promise<LightMyRequestResponse>;
  patch(url: string, body?: unknown, options?: RequestOptions): Promise<LightMyRequestResponse>;
  delete(url: string, options?: RequestOptions): Promise<LightMyRequestResponse>;
  /**
   * POSTs `bytes` as `application/octet-stream`, with the name in `x-file-name` as
   * `encodeURIComponent(fileName)`; `null` omits the header. Cookie and CSRF go as usual, and
   * `options.headers` can still override or drop any header.
   */
  upload(
    url: string,
    bytes: Uint8Array,
    fileName: string | null,
    options?: Omit<RequestOptions, 'body' | 'rawBody'>,
  ): Promise<LightMyRequestResponse>;
  /** The session cookie's value, or null when the api cleared it or never set one. */
  cookie: string | null;
  csrfToken: string | null;
  user: SessionUser | null;
}

export interface Clock {
  now(): Date;
  set(at: Date): void;
  /** Moves the clock forward by `ms` milliseconds. */
  advance(ms: number): void;
}

export interface Harness {
  app: FastifyInstance;
  /** The config the app was built with, env overrides applied. */
  config: Config;
  /** The app's file store: a fresh memory store unless one was passed in. */
  store: MemoryFileStore;
  db: AppDb;
  handle: DbHandle;
  clock: Clock;
  /** Every log line the app wrote, parsed. */
  logs: Record<string, unknown>[];
  /** A client with no session. */
  client(): Client;
  /** Runs first-run setup and returns the signed-in admin's client. */
  setupAdmin(admin?: { email?: string; displayName?: string; password?: string }): Promise<Client>;
  /**
   * Signs in and returns the client; throws unless the api answers 200. It first clears the
   * user's `must_change_password` in the DB, so suites get a working session from an
   * admin-set (temporary) password; `{ temporary: true }` keeps the flag.
   */
  signIn(email: string, password: string, options?: SignInOptions): Promise<Client>;
  close(): Promise<void>;
}

export interface SignInOptions {
  /** Keep `must_change_password` as the DB has it, so the session is gated. */
  temporary?: boolean;
}

export interface HarnessOptions {
  /** Defaults to `info`, captured in `logs`. An `env.LOG_LEVEL` wins over it. */
  logLevel?: LogLevel;
  /**
   * Merged over the harness's env (`DATABASE_PATH=:memory:`, `RATE_LIMIT_MULTIPLIER=1000` so
   * suites don't trip limits) before `loadConfig`. Rate-limit tests pass
   * `{ RATE_LIMIT_MULTIPLIER: '1' }`; hosted tests pass `{ HOSTED: 'true' }`.
   */
  env?: Record<string, string>;
  start?: Date;
  store?: MemoryFileStore;
}

/** The name header the upload protocol uses (K2's `FILE_NAME_HEADER`). */
const FILE_NAME_HEADER = 'x-file-name';

const COOKIE_VALUE = /^[^=]+=([^;]*)/;

function cookieFrom(
  response: LightMyRequestResponse,
  name: string,
  current: string | null,
): string | null {
  const header = response.headers['set-cookie'];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  let cookie = current;
  for (const line of lines) {
    if (!line.startsWith(`${name}=`)) continue;
    const value = COOKIE_VALUE.exec(line)?.[1] ?? '';
    const cleared =
      value === '' || /Max-Age=0\b/i.test(line) || /Expires=Thu, 01 Jan 1970/i.test(line);
    cookie = cleared ? null : value;
  }
  return cookie;
}

/** A fresh app on a migrated in-memory DB with a clock the test sets. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const store = options.store ?? createMemoryStore();
  const handle = openDb(':memory:');
  runMigrations(handle.db);
  let current = new Date((options.start ?? START).getTime());
  const clock: Clock = {
    now: () => new Date(current.getTime()),
    set: (at) => {
      current = new Date(at.getTime());
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
  const logs: Record<string, unknown>[] = [];
  const config = loadConfig({
    DATABASE_PATH: ':memory:',
    LOG_LEVEL: options.logLevel ?? 'info',
    RATE_LIMIT_MULTIPLIER: '1000',
    ...options.env,
  });
  // The client keeps whichever session cookie the app's mode uses.
  const cookieName = sessionCookieName(config);
  const app = buildApp({
    config,
    db: handle.db,
    now: () => clock.now(),
    store,
    logStream: {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });

  function client(): Client {
    const self: Client = {
      cookie: null,
      csrfToken: null,
      user: null,
      async request(method, url, { body, rawBody, headers = {} } = {}) {
        const sent: Record<string, string> = {};
        if (self.cookie !== null) sent.cookie = `${cookieName}=${self.cookie}`;
        if (self.csrfToken !== null) sent[CSRF_HEADER] = self.csrfToken;
        const payload = payloadOf(body, rawBody);
        if (rawBody === undefined && body !== undefined) sent['content-type'] = 'application/json';
        for (const [name, value] of Object.entries(headers)) {
          if (value === null) Reflect.deleteProperty(sent, name);
          else sent[name] = value;
        }
        const response = await app.inject({
          method,
          url,
          headers: sent,
          ...(payload === undefined ? {} : { payload }),
        });
        self.cookie = cookieFrom(response, cookieName, self.cookie);
        if (self.cookie === null) {
          self.csrfToken = null;
          self.user = null;
        }
        const parsed = sessionResponseSchema.safeParse(safeJson(response.body));
        if (response.statusCode < 300 && parsed.success) {
          self.csrfToken = parsed.data.csrfToken;
          self.user = parsed.data.user;
        }
        return response;
      },
      get: (url, opts) => self.request('GET', url, opts),
      post: (url, body, opts) => self.request('POST', url, { ...opts, body }),
      put: (url, body, opts) => self.request('PUT', url, { ...opts, body }),
      patch: (url, body, opts) => self.request('PATCH', url, { ...opts, body }),
      delete: (url, opts) => self.request('DELETE', url, opts),
      upload: (url, bytes, fileName, opts = {}) =>
        self.request('POST', url, {
          ...opts,
          rawBody: bytes,
          headers: {
            'content-type': 'application/octet-stream',
            ...(fileName === null ? {} : { [FILE_NAME_HEADER]: encodeURIComponent(fileName) }),
            ...opts.headers,
          },
        }),
    };
    return self;
  }

  async function setupAdmin(
    admin: { email?: string; displayName?: string; password?: string } = {},
  ) {
    const c = client();
    const response = await c.post('/api/setup', { ...ADMIN, ...admin });
    if (response.statusCode !== 201) {
      throw new Error(`setup answered ${String(response.statusCode)}: ${response.body}`);
    }
    return c;
  }

  async function signIn(email: string, password: string, options: SignInOptions = {}) {
    if (options.temporary !== true) {
      // Emails are stored trimmed and lowercased.
      const stored = email.trim().toLowerCase();
      handle.db.update(user).set({ mustChangePassword: false }).where(eq(user.email, stored)).run();
    }
    const c = client();
    const response = await c.post('/api/session', { email, password });
    if (response.statusCode !== 200) {
      throw new Error(`sign-in answered ${String(response.statusCode)}: ${response.body}`);
    }
    return c;
  }

  return {
    app,
    config,
    store,
    db: handle.db,
    handle,
    clock,
    logs,
    client,
    setupAdmin,
    signIn,
    async close() {
      await app.close();
      if (handle.sqlite.open) handle.sqlite.close();
    },
  };
}

/** What `inject` sends: raw bytes as they are (only the view's own bytes), JSON as text. */
function payloadOf(body: unknown, rawBody: string | Uint8Array | undefined) {
  if (typeof rawBody === 'string') return rawBody;
  if (rawBody !== undefined) {
    return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  }
  return body === undefined ? undefined : JSON.stringify(body);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
