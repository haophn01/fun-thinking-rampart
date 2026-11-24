import { Outlet } from 'react-router';
import { ApiStatus } from './ApiStatus';
import { Masthead } from './Masthead';
import styles from './Shell.module.css';

export function Shell() {
  return (
    <>
      <Masthead />
      <ApiStatus />
      <main className={styles.main}>
        <Outlet />
      </main>
    </>
  );
}
