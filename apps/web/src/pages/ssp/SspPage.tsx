import { useId, useState, type ComponentType, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { usePageTitle } from '../usePageTitle';
import styles from './ssp.module.css';
import { SSP_TABS, stepTab, tabFromParam, type SspTabId } from './tabs';
import { AssetsTab } from './tabs/AssetsTab';
import { DocumentControlTab } from './tabs/DocumentControlTab';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { ExportTab } from './tabs/ExportTab';
import { IdentificationTab } from './tabs/IdentificationTab';
import { ProvidersTab } from './tabs/ProvidersTab';

const PANELS: Record<SspTabId, ComponentType> = {
  identification: IdentificationTab,
  environment: EnvironmentTab,
  assets: AssetsTab,
  providers: ProvidersTab,
  'document-control': DocumentControlTab,
  export: ExportTab,
};

/** The keys that move between tabs, and where each goes from `from`. */
function keyTarget(key: string, from: SspTabId): SspTabId | null {
  switch (key) {
    case 'ArrowRight':
      return stepTab(from, 1);
    case 'ArrowLeft':
      return stepTab(from, -1);
    case 'Home':
      return SSP_TABS[0].id;
    case 'End':
      return SSP_TABS[SSP_TABS.length - 1]?.id ?? from;
    default:
      return null;
  }
}

/**
 * The SSP workspace: one tab per SSP section, chosen by `?tab=`. A panel mounts on its first
 * visit and stays mounted while hidden, so a draft survives a tab switch.
 */
export function SspPage() {
  usePageTitle('SSP');
  const baseId = useId();
  const [params, setParams] = useSearchParams();
  const selected = tabFromParam(params.get('tab'));
  const [visited, setVisited] = useState<ReadonlySet<SspTabId>>(() => new Set([selected]));
  // Adjusting state while rendering: the newly selected panel joins the mounted ones.
  if (!visited.has(selected)) setVisited(new Set([...visited, selected]));

  const tabId = (id: SspTabId) => `${baseId}-tab-${id}`;
  const panelId = (id: SspTabId) => `${baseId}-panel-${id}`;

  function select(id: SspTabId, replace: boolean) {
    if (id === selected) return;
    setParams({ tab: id }, { replace });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const target = keyTarget(event.key, selected);
    if (target === null) return;
    event.preventDefault();
    // Arrow keys replace the entry, so Back doesn't step through every tab the keys passed.
    select(target, true);
    document.getElementById(tabId(target))?.focus();
  }

  return (
    <section className={styles.page}>
      <h1>SSP</h1>
      <div className={styles.tabs} role="tablist" aria-label="SSP sections">
        {SSP_TABS.map((tab) => {
          const isSelected = tab.id === selected;
          return (
            <button
              key={tab.id}
              id={tabId(tab.id)}
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={isSelected}
              aria-controls={visited.has(tab.id) ? panelId(tab.id) : undefined}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => {
                select(tab.id, false);
              }}
              onKeyDown={onKeyDown}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {SSP_TABS.filter((tab) => visited.has(tab.id)).map((tab) => {
        const Panel = PANELS[tab.id];
        return (
          <div
            key={tab.id}
            id={panelId(tab.id)}
            role="tabpanel"
            aria-labelledby={tabId(tab.id)}
            className={styles.panel}
            hidden={tab.id !== selected}
          >
            <Panel />
          </div>
        );
      })}
    </section>
  );
}
