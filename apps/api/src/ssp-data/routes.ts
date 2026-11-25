import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../routes';
import { registerAssetRoutes } from './assets/routes';
import { registerDiagramLinkRoutes } from './diagrams/routes';
import { registerDocumentControlRoutes } from './document-control/routes';
import { registerSspProfileRoutes } from './profile/routes';
import { registerServiceProviderRoutes } from './providers/routes';
import { registerResponsibilityRoutes } from './responsibilities/routes';
import { registerSystemRoleRoutes } from './roles/routes';

/** What each SSP data module exports: it adds its routes to the guarded api plugin. */
export type SspDataRoutes = (api: FastifyInstance, deps: ApiDeps) => void;

/**
 * The SSP data api under `/api/ssp/*` (never `GET /api/ssp/export`, which the SSP export owns).
 * Registered inside `registerApiRoutes`, so the session guard covers every route.
 */
export const registerSspDataRoutes: SspDataRoutes = (api, deps) => {
  registerSspProfileRoutes(api, deps);
  registerSystemRoleRoutes(api, deps);
  registerAssetRoutes(api, deps);
  registerDiagramLinkRoutes(api, deps);
  registerServiceProviderRoutes(api, deps);
  registerResponsibilityRoutes(api, deps);
  registerDocumentControlRoutes(api, deps);
};
