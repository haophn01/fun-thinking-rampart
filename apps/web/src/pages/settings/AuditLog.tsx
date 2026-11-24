import {
  AUDIT_ENTITY_TYPES,
  auditPageSchema,
  type AuditEntityType,
  type AuditEvent,
} from '@rampart/api/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../../api/client';
import { Alert, Button, Select } from '../../look';
import { ACTION_LABELS, ENTITY_LABELS } from './auditLabels';
import styles from './settings.module.css';

const PAGE_SIZE = 50;

/** Compact `before → after`, or nothing when the event holds neither. */
function changeText(event: AuditEvent): string | null {
  if (event.before === null && event.after === null) return null;
  return `${JSON.stringify(event.before)} → ${JSON.stringify(event.after)}`;
}

/** The audit log, newest first, paged by the `before` cursor and filtered by entity type. */
export function AuditLog() {
  const [filter, setFilter] = useState<AuditEntityType | ''>('');
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  // Only the latest request may write state, so a slow old page can't land after a new filter.
  const latest = useRef(0);

  const load = useCallback(async (entityType: AuditEntityType | '', before: number | null) => {
    const request = ++latest.current;
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (entityType !== '') query.set('entityType', entityType);
    if (before !== null) query.set('before', String(before));
    if (before === null) setStatus('loading');
    else setLoadingMore(true);
    try {
      const page = await apiGet(`/api/audit?${query.toString()}`, auditPageSchema);
      if (request !== latest.current) return;
      setEvents((current) => (before === null ? page.events : [...current, ...page.events]));
      setNextBefore(page.nextBefore);
      setStatus('ready');
    } catch {
      if (request !== latest.current) return;
      setStatus('error');
    } finally {
      if (request === latest.current) setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    // A new filter starts over: the loading state is set as the request begins.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(filter, null);
  }, [load, filter]);

  const retry = () => {
    void load(filter, events.length === 0 ? null : nextBefore);
  };

  return (
    <div className={styles.panel}>
      <Select
        label="Entity type"
        value={filter}
        onChange={(event) => {
          const value = event.target.value;
          setFilter(AUDIT_ENTITY_TYPES.find((type) => type === value) ?? '');
        }}
      >
        <option value="">All</option>
        {AUDIT_ENTITY_TYPES.map((type) => (
          <option key={type} value={type}>
            {ENTITY_LABELS[type]}
          </option>
        ))}
      </Select>

      {status === 'error' && (
        <div>
          <Alert tone="error">Couldn&apos;t load the audit log.</Alert>
          <Button className={styles.retry} onClick={retry}>
            Retry
          </Button>
        </div>
      )}
      {status === 'loading' && <p className={styles.muted}>Loading the audit log…</p>}
      {status === 'ready' && events.length === 0 && (
        <p className={styles.muted}>No audit events yet.</p>
      )}

      {events.length > 0 && (
        <ul className={styles.list}>
          {events.map((event) => {
            const change = changeText(event);
            return (
              <li
                key={event.id}
                className={styles.row}
                aria-label={`Audit event ${String(event.id)}: ${ACTION_LABELS[event.action]}`}
              >
                <div className={styles.identity} style={{ gridColumn: '1 / -1' }}>
                  <p className={styles.name}>{ACTION_LABELS[event.action]}</p>
                  <p className={styles.email}>
                    <time dateTime={event.at} title={event.at}>
                      {new Date(event.at).toLocaleString()}
                    </time>
                    {' · '}
                    {event.actor?.displayName ?? 'System'}
                  </p>
                  <p className={styles.email}>
                    {`${ENTITY_LABELS[event.entityType]} ${event.entityId}`}
                  </p>
                  {change !== null && (
                    <code style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                      {change}
                    </code>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {nextBefore !== null && status === 'ready' && (
        <div>
          <Button
            disabled={loadingMore}
            onClick={() => {
              void load(filter, nextBefore);
            }}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
