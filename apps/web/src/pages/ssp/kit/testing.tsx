// A test helper for the SSP tabs, not a test: it fakes the api at the network boundary and
// renders the signed-in app at /ssp. Each tab's tests import it.
import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation, useNavigate, type Location } from 'react-router';
import { vi } from 'vitest';
import { AuthedApp } from '../../../App';

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}
export type Handler = (call: Call) => Response | Promise<Response>;
/** Handlers keyed `'METHOD /path'`, such as `'GET /api/ssp/profile'`. */
export type Routes = Record<string, Handler>;

export const ME = { id: 'u-1', displayName: 'Ada Admin' };

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

/** The api's error envelope. */
export function apiError(status: number, code: string, message = code, details?: unknown) {
  return json(status, {
    error: { code, message, requestId: 'r', ...(details === undefined ? {} : { details }) },
  });
}

/** A held answer: the request arrives, and the test decides when and how it is answered. */
export interface Deferred {
  /** Resolves with the call once the request has been sent. */
  readonly requested: Promise<Call>;
  /** Answers the held request. */
  answer: (response: Response) => void;
}

export interface StubbedApi {
  /** Every call, in order. */
  readonly calls: readonly Call[];
  /** The calls to one `'METHOD /path'`. */
  sent: (key: string) => Call[];
  /** Holds the next call to `key` until the test answers it. */
  defer: (key: string) => Deferred;
  /** Waits until `key` has been called `count` times (default 1), then returns those calls. */
  waitForCall: (key: string, count?: number) => Promise<Call[]>;
}

/**
 * Stubs `fetch` with the session (as `role`), health and the given handlers. Anything else
 * answers 404 `not_found`. Undo it with `vi.unstubAllGlobals()`.
 */
export function stubApi(
  routes: Routes = {},
  { role = 'admin' }: { role?: 'admin' | 'contributor' } = {},
): StubbedApi {
  const calls: Call[] = [];
  const held = new Map<string, ((call: Call) => Promise<Response>)[]>();
  const all: Routes = {
    'GET /api/session': () =>
      json(200, {
        setupRequired: false,
        user: { ...ME, email: 'ada@example.com', role },
        csrfToken: 'csrf-1',
      }),
    'GET /api/health': () => json(200, { status: 'ok', db: 'ok' }),
    ...routes,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? 'GET',
        path: input,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
        headers: new Headers(init.headers),
      };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const next = held.get(key)?.shift();
      if (next !== undefined) return next(call);
      const handler = all[key] ?? (() => apiError(404, 'not_found'));
      return Promise.resolve(handler(call));
    }),
  );
  const sent = (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key);
  return {
    calls,
    sent,
    defer(key) {
      let arrived: (call: Call) => void = () => undefined;
      let answer: (response: Response) => void = () => undefined;
      const requested = new Promise<Call>((resolve) => (arrived = resolve));
      const response = new Promise<Response>((resolve) => (answer = resolve));
      const queue = held.get(key) ?? [];
      queue.push((call) => {
        arrived(call);
        return response;
      });
      held.set(key, queue);
      return { requested, answer };
    },
    async waitForCall(key, count = 1) {
      await waitFor(() => {
        if (sent(key).length < count) throw new Error(`waiting for ${String(count)} × ${key}`);
      });
      return sent(key);
    },
  };
}

export interface RenderedSsp {
  /** The router's current location. */
  location: () => Location;
  /** The browser's Back. */
  back: () => Promise<void>;
}

/** Renders the signed-in app at `/ssp`, or `/ssp?tab=<tab>`. */
export function renderSsp(tab?: string): RenderedSsp {
  const probe: { location?: Location; navigate?: ReturnType<typeof useNavigate> } = {};
  function Probe() {
    const location = useLocation();
    const navigate = useNavigate();
    useEffect(() => {
      probe.location = location;
      probe.navigate = navigate;
    });
    return null;
  }
  render(
    <MemoryRouter initialEntries={[tab === undefined ? '/ssp' : `/ssp?tab=${tab}`]}>
      <AuthedApp />
      <Probe />
    </MemoryRouter>,
  );
  return {
    location: () => {
      if (probe.location === undefined) throw new Error('not rendered');
      return probe.location;
    },
    back: async () => {
      await act(async () => {
        await probe.navigate?.(-1);
      });
    },
  };
}
