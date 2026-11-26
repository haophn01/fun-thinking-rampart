import { sspProfileResponseSchema, type SspProfileResponse } from '@rampart/api/contract';
import type { ReactNode } from 'react';
import { LoadError, Section, SspProfileForm, useLoad, type Loaded } from '../kit';
import styles from '../ssp.module.css';
import { DiagramsSection } from './DiagramsSection';

type ProfileGroups = Parameters<typeof SspProfileForm>[0]['groups'];

function ProfileSection({
  number,
  title,
  groups,
  profile,
}: {
  number: number;
  title: string;
  groups: ProfileGroups;
  profile: Loaded<SspProfileResponse>;
}) {
  let body: ReactNode;
  if (profile.data !== null) {
    body = (
      <SspProfileForm
        title={title}
        groups={groups}
        profile={profile.data.profile}
        onSaved={(stored) => {
          profile.replace({ profile: stored });
        }}
      />
    );
  } else if (profile.failed) {
    body = (
      <LoadError
        title="Can't load the SSP profile"
        onRetry={() => {
          void profile.reload();
        }}
      />
    );
  } else {
    body = <p className={styles.muted}>Loading the SSP profile…</p>;
  }
  return (
    <Section number={number} title={title}>
      {body}
    </Section>
  );
}

/** Environment: the CUI description, the topology and data-flow narratives, and diagram links. */
export function EnvironmentTab() {
  const profile = useLoad('/api/ssp/profile', sspProfileResponseSchema);
  return (
    <>
      <ProfileSection number={1} title="CUI description" groups={['cui']} profile={profile} />
      <ProfileSection
        number={2}
        title="System environment"
        groups={['environment']}
        profile={profile}
      />
      <DiagramsSection />
    </>
  );
}
