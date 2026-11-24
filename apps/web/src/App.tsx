import { BrowserRouter, Route, Routes } from 'react-router';
import { Gate } from './auth/Gate';
import { SessionProvider } from './auth/session';
import { NotFound } from './pages/NotFound';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { Shell } from './shell/Shell';
import { APP_ROUTES } from './shell/routes';

/** The route tree, without a router or session, so tests can mount it in a MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        {APP_ROUTES.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={<PlaceholderPage title={route.label} />}
          />
        ))}
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
