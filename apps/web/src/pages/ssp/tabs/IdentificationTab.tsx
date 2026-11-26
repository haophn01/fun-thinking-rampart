import { systemProfileResponseSchema, type SystemProfile } from '@rampart/api/contract';
import { useCallback, type ReactNode } from 'react';
import { apiSend } from '../../../api/client';
import { LoadError, Section, useLoad } from '../kit';
import { ProfileForm, type ProfilePatch } from '../ProfileForm';
import styles from '../ssp.module.css';

/** Identification & roles. For now, the V1 system profile. */
export function IdentificationTab() {
  const profile = useLoad('/api/system-profile', systemProfileResponseSchema);

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

  return (
    <Section number={1} title="System profile">
      {form}
    </Section>
  );
}
