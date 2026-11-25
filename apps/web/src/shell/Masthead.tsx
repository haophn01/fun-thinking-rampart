import { PRODUCT_NAME } from '@rampart/api/contract';
import { useRef, useState, type KeyboardEvent } from 'react';
import { UserSlot } from '../auth/UserSlot';
import { Button } from '../look';
import styles from './Masthead.module.css';
import { NavMenu } from './NavMenu';
import { RegistrationMarks } from './RegistrationMarks';

const NAV_ID = 'primary-nav';

export function Masthead() {
  const [open, setOpen] = useState(false);
  // The look's Button takes no ref, so focus is returned through its wrapper.
  const menuWrap = useRef<HTMLSpanElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && open) {
      setOpen(false);
      menuWrap.current?.querySelector('button')?.focus();
    }
  }

  return (
    <header className={styles.masthead} onKeyDown={onKeyDown}>
      <RegistrationMarks />
      <div className={styles.bar}>
        <span className={styles.brand}>
          {PRODUCT_NAME}
          <span className={styles.tag}>CMMC L2</span>
        </span>
        <span ref={menuWrap} className={styles.menu}>
          <Button
            aria-expanded={open}
            aria-controls={NAV_ID}
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            Menu
          </Button>
        </span>
      </div>
      <NavMenu
        id={NAV_ID}
        open={open}
        onNavigate={() => {
          setOpen(false);
        }}
      />
      {/* On a phone the user slot sits in the menu, under the nav. */}
      <div className={styles.user} data-open={open}>
        <UserSlot />
      </div>
    </header>
  );
}
