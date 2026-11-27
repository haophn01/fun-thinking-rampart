import type { ComponentType } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { ChangePasswordPage } from './auth/ChangePasswordPage';
import { Gate } from './auth/Gate';
import { SessionProvider } from './auth/session';
import { AssessmentPage } from './pages/assessment/AssessmentPage';
import { DashboardPage } from './pages/dashboard/DashboardPage';
import { EvidencePage } from './pages/evidence/EvidencePage';
import { NotFound } from './pages/NotFound';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { PoamPage } from './pages/poam/PoamPage';
import { PoliciesPage } from './pages/policies/PoliciesPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { SspPage } from './pages/ssp/SspPage';
import { Shell } from './shell/Shell';
import { APP_ROUTES } from './shell/routes';

/** The routes that have a page module; every other nav route shows its empty-state page. */
const PAGES: Readonly<Record<string, ComponentType>> = {
  '/': DashboardPage,
  '/assessment': AssessmentPage,
  '/poam': PoamPage,
  '/evidence': EvidencePage,
  '/policies': PoliciesPage,
  '/ssp': SspPage,
  '/settings': SettingsPage,
};

/** The route tree, without a router or session. Its pages expect `SessionProvider` above them. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        {APP_ROUTES.map((route) => {
          const Page = PAGES[route.path];
          return (
            <Route
              key={route.path}
              path={route.path}
              element={Page ? <Page /> : <PlaceholderPage title={route.label} />}
            />
          );
        })}
        {/* The signed-in user's own page: inside the shell, but not a nav tab. */}
        <Route path="/account/password" element={<ChangePasswordPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/** The session store and gate around the routes; mount it inside any router. */
export function AuthedApp() {
  return (
    <SessionProvider>
      <Gate>
        <AppRoutes />
      </Gate>
    </SessionProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthedApp />
    </BrowserRouter>
  );
}
