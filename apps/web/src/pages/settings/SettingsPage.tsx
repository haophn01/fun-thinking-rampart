import { useId, type ReactNode } from 'react';
import { useSession } from '../../auth/session';
import { SectionLabel } from '../../look';
import { usePageTitle } from '../usePageTitle';
import styles from './settings.module.css';
import { UsersPanel } from './UsersPanel';

interface SettingsSection {
  key: string;
  title: string;
  body: ReactNode;
}

function Section({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionHead}>
        <SectionLabel number={number}>{title}</SectionLabel>
      </h2>
      {children}
    </section>
  );
}

/**
 * Settings, in the order Assessment, Users (admin only), Audit log. Sections are numbered in the
 * order they show, so a contributor's numbers have no gaps.
 */
export function SettingsPage() {
  usePageTitle('Settings');
  const { user } = useSession();
  const sections: SettingsSection[] = [
    ...(user?.role === 'admin' ? [{ key: 'users', title: 'Users', body: <UsersPanel /> }] : []),
  ];

  return (
    <section className={styles.page}>
      <h1>Settings</h1>
      {sections.length === 0 && <p>This section isn&apos;t built yet.</p>}
      {sections.map((section, index) => (
        <Section key={section.key} number={index + 1} title={section.title}>
          {section.body}
        </Section>
      ))}
    </section>
  );
}
