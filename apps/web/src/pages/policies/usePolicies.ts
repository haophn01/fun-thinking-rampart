import {
  policyListSchema,
  policyResponseSchema,
  type Policy,
  type PolicyVersion,
} from '@rampart/api/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiGet, apiSend, apiUpload } from '../../api/client';

/** The Alert text for a failed policy change or upload. */
export function failureText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'csrf_failed':
        return 'The security check failed. Reload the page and try again.';
      case 'not_found':
        return 'That policy no longer exists. Reload the page.';
      case 'network_error':
        return "Can't reach the API. Check your connection and try again.";
      case 'validation_failed':
        // A file refused before sending (status 0) carries a message ready to show.
        return error.status === 0 ? error.message : 'The change was not accepted.';
      case 'payload_too_large':
      case 'unsupported_file_type':
        return error.message;
    }
  }
  return "Couldn't save the change. Try again.";
}

const UNITS = ['B', 'KB', 'MB', 'GB'];

/** A file size as people read it: `512 B`, `4 KB`, `1.4 MB`. */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 ? String(value) : String(Math.round(value * 10) / 10);
  return `${shown} ${UNITS[unit] ?? 'B'}`;
}

/** The newest version (the api sorts newest first), or `undefined` for a policy with no file. */
export function latestVersion(policy: Policy): PolicyVersion | undefined {
  return policy.versions[0];
}

export interface PoliciesState {
  /** `null` until the first load answers. */
  policies: Policy[] | null;
  loadFailed: boolean;
  reload: () => Promise<void>;
  create: (body: { title: string; description: string }) => Promise<void>;
  uploadVersion: (policy: Policy, file: File) => Promise<void>;
  saveLinks: (policy: Policy, requirementIds: string[]) => Promise<void>;
}

/** The page's policies: the list and every write, each answering with the policy as stored. */
export function usePolicies(): PoliciesState {
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Each load bumps this; an answer from an older load (or after unmount) is dropped.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    latest.current += 1;
    const run = latest.current;
    const list = await apiGet('/api/policies', policyListSchema).then(
      (body) => body.items,
      () => null,
    );
    if (run !== latest.current) return;
    // The list stays as it was when a reload fails; only a first load shows the error.
    if (list !== null) setPolicies(list);
    setLoadFailed(list === null);
  }, []);

  useEffect(() => {
    // reload() sets state only after its request answers, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    return () => {
      latest.current += 1;
    };
  }, [reload]);

  const replace = useCallback((policy: Policy) => {
    setPolicies((list) => list?.map((p) => (p.id === policy.id ? policy : p)) ?? null);
  }, []);

  const create = useCallback(
    async (body: { title: string; description: string }) => {
      await apiSend('POST', '/api/policies', { ...body, requirementIds: [] }, policyResponseSchema);
      // The api sorts by title, so ask it for the list instead of placing the new one.
      await reload();
    },
    [reload],
  );

  const uploadVersion = useCallback(
    async (policy: Policy, file: File) => {
      // 201 for a new version and 200 for an identical repeat both answer with the stored policy.
      const { item } = await apiUpload(
        `/api/policies/${encodeURIComponent(policy.id)}/versions`,
        file,
        file.name,
        policyResponseSchema,
      );
      replace(item);
    },
    [replace],
  );

  const saveLinks = useCallback(
    async (policy: Policy, requirementIds: string[]) => {
      const { item } = await apiSend(
        'PUT',
        `/api/policies/${encodeURIComponent(policy.id)}/requirements`,
        { requirementIds },
        policyResponseSchema,
      );
      replace(item);
    },
    [replace],
  );

  return { policies, loadFailed, reload, create, uploadVersion, saveLinks };
}
