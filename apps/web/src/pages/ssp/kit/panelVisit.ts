import { createContext } from 'react';

/**
 * How many times the enclosing SSP panel has been shown again after its first visit. The
 * workspace bumps it each time the panel's tab is selected again, or the browser tab comes
 * back while it is selected; `useLoad` re-runs its GET on each bump. The panel stays
 * mounted, so drafts survive.
 */
export const PanelVisit = createContext(0);
