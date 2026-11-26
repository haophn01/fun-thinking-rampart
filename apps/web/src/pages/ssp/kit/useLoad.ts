import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, type ResponseSchema } from '../../../api/client';

export interface Loaded<T> {
  /** `null` until the first load answers. */
  data: T | null;
  failed: boolean;
  reload: () => Promise<void>;
  /** Puts a value in place without a request, such as the answer to a save. */
  replace: (data: T) => void;
}

/** Loads one GET on mount. A failed reload keeps the data it had; only a first load shows the error. */
export function useLoad<T>(path: string, schema: ResponseSchema<T>): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  // Each load (and each replace) bumps this; an answer from an older load, or after unmount, is dropped.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    latest.current += 1;
    const run = latest.current;
    const body = await apiGet(path, schema).then(
      (value) => value,
      () => null,
    );
    if (run !== latest.current) return;
    if (body !== null) setData(body);
    setFailed(body === null);
  }, [path, schema]);
  const replace = useCallback((value: T) => {
    latest.current += 1;
    setData(value);
    setFailed(false);
  }, []);
  useEffect(() => {
    // reload() sets state only after its request answers, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    return () => {
      latest.current += 1;
    };
  }, [reload]);
  return { data, failed, reload, replace };
}
