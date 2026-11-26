/** The SSP workspace's sections, in tab order. `id` is the `?tab=` value. */
export const SSP_TABS = [
  { id: 'identification', label: 'Identification & roles' },
  { id: 'environment', label: 'Environment' },
  { id: 'assets', label: 'Assets' },
  { id: 'providers', label: 'Service providers & matrix' },
  { id: 'document-control', label: 'Document control' },
  { id: 'export', label: 'Lint & export' },
] as const satisfies readonly { id: string; label: string }[];

export type SspTabId = (typeof SSP_TABS)[number]['id'];

const DEFAULT_TAB: SspTabId = 'identification';

/** The tab a `?tab=` value names; none, or an unknown one, is Identification. */
export function tabFromParam(value: string | null): SspTabId {
  return SSP_TABS.find((tab) => tab.id === value)?.id ?? DEFAULT_TAB;
}

/** The tab `step` places from `from`, wrapping at both ends. */
export function stepTab(from: SspTabId, step: number): SspTabId {
  const index = SSP_TABS.findIndex((tab) => tab.id === from);
  const next = (index + step + SSP_TABS.length) % SSP_TABS.length;
  return (SSP_TABS[next] ?? SSP_TABS[0]).id;
}
