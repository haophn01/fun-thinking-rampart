import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../look';
import styles from './kit.module.css';

export interface RemoveButtonProps {
  /** What is removed, as the question names it: "Remove <name>?". */
  name: string;
  /** Called only after "Confirm remove". */
  onConfirm: () => void | Promise<void>;
}

/** "Remove", then "Remove <name>?" with "Confirm remove" and "Cancel". */
export function RemoveButton({ name, onConfirm }: RemoveButtonProps) {
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  // Focus follows the swap: onto Confirm when asking, back onto Remove after Cancel.
  const asked = useRef(false);
  useEffect(() => {
    if (asking || asked.current) wrap.current?.querySelector('button')?.focus();
    asked.current = asking;
  }, [asking]);

  if (!asking) {
    return (
      <span ref={wrap} className={styles.removeWrap}>
        <Button
          onClick={() => {
            setAsking(true);
          }}
        >
          Remove
        </Button>
      </span>
    );
  }
  return (
    <span ref={wrap} className={styles.confirm} role="group" aria-label={`Remove ${name}`}>
      <span className={styles.question}>{`Remove ${name}?`}</span>
      <span className={styles.actions}>
        <Button
          disabled={pending}
          onClick={() => {
            setPending(true);
            // The caller shows its own failure; this only restores the button.
            void Promise.resolve()
              .then(onConfirm)
              .catch(() => undefined)
              .finally(() => {
                setPending(false);
                setAsking(false);
              });
          }}
        >
          Confirm remove
        </Button>
        <Button
          disabled={pending}
          onClick={() => {
            setAsking(false);
          }}
        >
          Cancel
        </Button>
      </span>
    </span>
  );
}
