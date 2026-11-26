import type { SecuritySeam } from './context';

/**
 * With `config.serveWeb`, serves the built web app from `config.webDistPath`. Registered on the
 * root after the api routes. A seam for now: without it no web route exists, as today.
 */
export const registerWebApp: SecuritySeam = () => {
  // Filled in with the static manifest and the SPA fallback.
};
