import styles from './RegistrationMarks.module.css';

function Mark({ side }: { side: 'left' | 'right' }) {
  return (
    <svg
      className={styles.mark}
      data-side={side}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="6" />
      <path d="M12 0v24M0 12h24" />
    </svg>
  );
}

/** Crosshair registration marks at the top corners. Decorative. */
export function RegistrationMarks() {
  return (
    <>
      <Mark side="left" />
      <Mark side="right" />
    </>
  );
}
