import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { AppDb } from '../../db/client';
import type { FileStore } from '../../storage';
import type { Config } from '../config';
import { registerAssessmentRoutes } from '../assessment/routes';
import { registerAuditRoutes } from '../audit/list';
import { registerGuard } from '../auth/guard';
import { registerAuthRoutes } from '../auth/routes';
import { registerEvidenceRoutes } from '../evidence/routes';
import { registerPoamRoutes } from '../poam/routes';
import { registerPolicyRoutes } from '../policies/routes';
import { markGuardedScope } from '../security/route-table';
import { registerSspDataRoutes } from '../ssp-data/routes';
import { registerSspRoutes } from '../ssp/routes';
import { registerSystemProfileRoutes } from '../system-profile/routes';
import { registerUserRoutes } from '../users/routes';

/** What every api route needs. */
export interface ApiDeps {
  /** The loaded settings: hosted mode picks the session cookie, for one. */
  config: Config;
  db: AppDb;
  /** The app clock: every expiry, lockout, audit `at` and "today" comes from it. */
  now: () => Date;
  /** Evidence and policy files, content-addressed by SHA-256. */
  store: FileStore;
}

/**
 * Registers the session-guarded api in its own encapsulated plugin. The guard denies by default:
 * a route here needs a signed-in user unless it sets `config: { public: true }`, and every write
 * on a session needs the CSRF header. Health and test-only routes on the root stay unguarded.
 */
export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  void app.register(async (api) => {
    // Before any route here, so the route table lists each of them as guarded.
    markGuardedScope(api);
    // Loaded first, so `request.cookies` is set before the guard's hook reads it.
    await api.register(cookie);
    registerGuard(api, deps);
    registerAuthRoutes(api, deps);
    registerUserRoutes(api, deps);
    registerAuditRoutes(api, deps);
    registerAssessmentRoutes(api, deps);
    registerPoamRoutes(api, deps);
    registerEvidenceRoutes(api, deps);
    registerPolicyRoutes(api, deps);
    registerSystemProfileRoutes(api, deps);
    registerSspRoutes(api, deps);
    registerSspDataRoutes(api, deps);
  });
}
