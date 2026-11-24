import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { openDb, runMigrations, type AppDb, type DbHandle } from '../../db/client';
import { buildApp } from '../app';
import { loadConfig, type LogLevel } from '../config';
import { CSRF_HEADER, SESSION_COOKIE, sessionResponseSchema, type SessionUser } from '../contract';

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
  body?: unknown;
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
  db: AppDb;
  handle: DbHandle;
  clock: Clock;
  /** Every log line the app wrote, parsed. */
  logs: Record<string, unknown>[];
  /** A client with no session. */
  client(): Client;
  /** Runs first-run setup and returns the signed-in admin's client. */
  setupAdmin(admin?: { email?: string; displayName?: string; password?: string }): Promise<Client>;
  /** Signs in and returns the client; throws unless the api answers 200. */
  signIn(email: string, password: string): Promise<Client>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Defaults to `info`, captured in `logs`. */
  logLevel?: LogLevel;
  start?: Date;
}

const COOKIE_VALUE = /^[^=]+=([^;]*)/;

function cookieFrom(response: LightMyRequestResponse, current: string | null): string | null {
  const header = response.headers['set-cookie'];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  let cookie = current;
  for (const line of lines) {
    if (!line.startsWith(`${SESSION_COOKIE}=`)) continue;
    const value = COOKIE_VALUE.exec(line)?.[1] ?? '';
    const cleared =
      value === '' || /Max-Age=0\b/i.test(line) || /Expires=Thu, 01 Jan 1970/i.test(line);
    cookie = cleared ? null : value;
  }
  return cookie;
}

/** A fresh app on a migrated in-memory DB with a clock the test sets. */
export function createHarness(options: HarnessOptions = {}): Harness {
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
  const config = loadConfig({ DATABASE_PATH: ':memory:', LOG_LEVEL: options.logLevel ?? 'info' });
  const app = buildApp({
    config,
    db: handle.db,
    now: () => clock.now(),
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
      async request(method, url, { body, headers = {} } = {}) {
        const sent: Record<string, string> = {};
        if (self.cookie !== null) sent.cookie = `${SESSION_COOKIE}=${self.cookie}`;
        if (self.csrfToken !== null) sent[CSRF_HEADER] = self.csrfToken;
        if (body !== undefined) sent['content-type'] = 'application/json';
        for (const [name, value] of Object.entries(headers)) {
          if (value === null) Reflect.deleteProperty(sent, name);
          else sent[name] = value;
        }
        const response = await app.inject({
          method,
          url,
          headers: sent,
          ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
        });
        self.cookie = cookieFrom(response, self.cookie);
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

  async function signIn(email: string, password: string) {
    const c = client();
    const response = await c.post('/api/session', { email, password });
    if (response.statusCode !== 200) {
      throw new Error(`sign-in answered ${String(response.statusCode)}: ${response.body}`);
    }
    return c;
  }

  return {
    app,
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
