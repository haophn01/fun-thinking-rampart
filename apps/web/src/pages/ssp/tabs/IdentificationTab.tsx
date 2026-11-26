import {
  sspProfileResponseSchema,
  systemProfileResponseSchema,
  type SystemProfile,
} from '@rampart/api/contract';
import { useCallback, type ReactNode } from 'react';
import { apiSend } from '../../../api/client';
import { LoadError, Section, SspProfileForm, useLoad } from '../kit';
import { ProfileForm, type ProfilePatch } from '../ProfileForm';
import styles from '../ssp.module.css';
import { RolesSection } from './RolesSection';

/** Identification & roles: the V1 system profile, the SSP identification fields, and roles. */
export function IdentificationTab() {
  const profile = useLoad('/api/system-profile', systemProfileResponseSchema);
  const identification = useLoad('/api/ssp/profile', sspProfileResponseSchema);

  const save = useCallback(async (patch: ProfilePatch): Promise<SystemProfile> => {
    const { profile: stored } = await apiSend(
      'PATCH',
      '/api/system-profile',
      patch,
      systemProfileResponseSchema,
    );
    return stored;
  }, []);

  let form: ReactNode;
  if (profile.data !== null) {
    form = <ProfileForm profile={profile.data.profile} onSave={save} />;
  } else if (profile.failed) {
    form = (
      <LoadError
        title="Can't load the system profile"
        onRetry={() => {
          void profile.reload();
        }}
      />
    );
  } else {
    form = <p className={styles.muted}>Loading the system profile…</p>;
  }

  let details: ReactNode;
  if (identification.data !== null) {
    details = (
      <SspProfileForm
        title="Identification"
        groups={['identification']}
        profile={identification.data.profile}
        onSaved={(stored) => {
          identification.replace({ profile: stored });
        }}
      />
    );
  } else if (identification.failed) {
    details = (
      <LoadError
        title="Can't load the identification details"
        onRetry={() => {
          void identification.reload();
        }}
      />
    );
  } else {
    details = <p className={styles.muted}>Loading the identification details…</p>;
  }

  return (
    <>
      <Section number={1} title="System profile">
        {form}
      </Section>
      <Section number={2} title="Identification">
        {details}
      </Section>
      <RolesSection number={3} />
    </>
  );
}
