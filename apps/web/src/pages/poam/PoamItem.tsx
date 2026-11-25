import {
  CLOSEOUT_CONFIRMER_LABELS,
  type CloseoutConfirmer,
  type CloseoutRequest,
  type CreatePoamItemRequest,
  type PatchPoamItemRequest,
  type PoamItem as PoamItemData,
  type User,
} from '@rampart/api/contract';
import type { ApiError } from '../../api/client';
import { Button } from '../../look';
import { CloseoutForm } from './CloseoutForm';
import { PoamForm } from './PoamForm';
import styles from './poam.module.css';

export function dayCount(n: number): string {
  return `${String(n)} ${n === 1 ? 'day' : 'days'}`;
}

/** "Due today", "N days left" or "Overdue by N days". */
export function dueText(daysToDue: number): string {
  if (daysToDue === 0) return 'Due today';
  if (daysToDue > 0) return `${dayCount(daysToDue)} left`;
  return `Overdue by ${dayCount(-daysToDue)}`;
}

export type ItemPanel = 'edit' | 'closeout' | null;

export interface PoamItemProps {
  item: PoamItemData;
  requirementText: string;
  confirmer: CloseoutConfirmer;
  isAdmin: boolean;
  users: readonly User[];
  panel: ItemPanel;
  onPanel: (panel: ItemPanel) => void;
  onCreate: (body: CreatePoamItemRequest) => Promise<ApiError | null>;
  onPatch: (id: string, body: PatchPoamItemRequest) => Promise<ApiError | null>;
  onCloseout: (id: string, body: CloseoutRequest) => Promise<ApiError | null>;
}

/** One POA&M item: requirement, plan, due text, flags, milestones, and its closeout or actions. */
export function PoamItem(props: PoamItemProps) {
  const { item, panel } = props;
  const open = item.status === 'open';
  const stillEligible = item.eligibility.eligible;
  const flags: string[] = [];
  if (open && item.dueAfterDeadline) flags.push('Due after the closeout deadline');
  if (open && !stillEligible && !item.readyToClose) flags.push('No longer eligible');
  if (open && item.readyToClose) flags.push('Ready for closeout');

  return (
    <li className={styles.card} data-state={item.status} data-overdue={item.overdue || undefined}>
      <div className={styles.top}>
        <span className={styles.mono}>{item.requirementId}</span>
        {open ? (
          <span className={styles.countdown} data-overdue={item.overdue || undefined}>
            {dueText(item.daysToDue)}
          </span>
        ) : (
          <span className={styles.countdown}>Closed</span>
        )}
      </div>
      <p>{props.requirementText}</p>
      <p className={styles.plan}>{item.plan}</p>
      <p className={styles.muted}>
        {`Due ${item.due} · Owner ${
          item.owner === null
            ? 'unassigned'
            : item.owner.active
              ? item.owner.displayName
              : `${item.owner.displayName} (inactive)`
        }`}
      </p>
      {flags.length > 0 && (
        <div className={styles.flags}>
          {flags.map((flag) => (
            <p key={flag} className={styles.flag}>
              {flag}
            </p>
          ))}
        </div>
      )}
      {item.milestones.length > 0 && (
        <div className={styles.milestoneList}>
          {item.milestones.map((m, i) => (
            <p key={`${String(i)}-${m.title}`}>
              {m.title} <span className={styles.muted}>{`due ${m.due}`}</span>{' '}
              <span className={styles.muted}>
                {m.doneOn === null ? 'not done' : `done ${m.doneOn}`}
              </span>
            </p>
          ))}
        </div>
      )}

      {item.closeout !== null && (
        <div className={styles.closeout}>
          <p>{`Closed on ${item.closeout.closedOn}`}</p>
          <p>{`Confirmed by ${CLOSEOUT_CONFIRMER_LABELS[item.closeout.confirmedBy]}`}</p>
          {item.closeout.c3paoName !== null && <p>{`C3PAO: ${item.closeout.c3paoName}`}</p>}
          {item.closeout.note !== null && <p>{item.closeout.note}</p>}
          <p className={styles.muted}>{`Recorded by ${item.closeout.recordedBy.displayName}`}</p>
          {item.closeout.late && <p className={styles.flag}>Closed after the closeout deadline</p>}
        </div>
      )}

      {open && panel === null && (
        <div className={styles.actions}>
          <Button
            onClick={() => {
              props.onPanel('edit');
            }}
          >
            Edit
          </Button>
          {props.isAdmin && (
            <Button
              disabled={!item.readyToClose}
              onClick={() => {
                props.onPanel('closeout');
              }}
            >
              Close out
            </Button>
          )}
        </div>
      )}
      {open && props.isAdmin && !item.readyToClose && panel === null && (
        <p className={styles.muted}>Mark the requirement Met to close this item out.</p>
      )}
      {open && panel === 'edit' && (
        <PoamForm
          mode={{ kind: 'edit', item, requirementText: props.requirementText }}
          users={props.users}
          onCreate={props.onCreate}
          onPatch={props.onPatch}
          onClose={() => {
            props.onPanel(null);
          }}
        />
      )}
      {open && props.isAdmin && panel === 'closeout' && (
        <CloseoutForm
          requirementId={item.requirementId}
          confirmer={props.confirmer}
          onSubmit={(body) => props.onCloseout(item.id, body)}
          onClose={() => {
            props.onPanel(null);
          }}
        />
      )}
    </li>
  );
}
