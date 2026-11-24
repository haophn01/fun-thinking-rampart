import { NavLink } from 'react-router';
import styles from './NavMenu.module.css';
import { APP_ROUTES } from './routes';

export interface NavMenuProps {
  id: string;
  open: boolean;
  onNavigate: () => void;
}

/** The text nav. On a phone it is hidden until `open`; the Masthead owns the Menu button. */
export function NavMenu({ id, open, onNavigate }: NavMenuProps) {
  return (
    <nav id={id} aria-label="Primary" className={styles.nav} data-open={open}>
      <ul className={styles.list}>
        {APP_ROUTES.map((route) => (
          <li key={route.path}>
            <NavLink
              to={route.path}
              end={route.path === '/'}
              className={styles.link ?? ''}
              onClick={onNavigate}
            >
              {route.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
