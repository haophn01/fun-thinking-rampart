export interface AppRoute {
  /** Router path; `/` is the Dashboard. */
  path: string;
  /** Nav label, h1 and the page part of `document.title`. */
  label: string;
}

export const APP_ROUTES: readonly AppRoute[] = [
  { path: '/', label: 'Dashboard' },
  { path: '/assessment', label: 'Assessment' },
  { path: '/poam', label: 'POA&M' },
  { path: '/evidence', label: 'Evidence' },
  { path: '/policies', label: 'Policies' },
  { path: '/ssp', label: 'SSP' },
  { path: '/settings', label: 'Settings' },
];
