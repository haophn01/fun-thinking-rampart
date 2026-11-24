import { assertIntact, assertKey, sha256Hex, StorageError, type FileStore } from '.';

/** The test store: `keys()` lists what is held, `corrupt(key)` changes its bytes in place. */
export type MemoryFileStore = FileStore & { keys(): string[]; corrupt(key: string): void };

/** Holds files in a Map, with the same keys, checks and errors as the local store. */
export function createMemoryStore(): MemoryFileStore {
  const files = new Map<string, Uint8Array>();

  return {
    put(bytes) {
      const sha256 = sha256Hex(bytes);
      const held = files.get(sha256);
      // Same rule as on disk: a held file whose hash is wrong is replaced.
      if (held === undefined || sha256Hex(held) !== sha256) {
        files.set(sha256, Uint8Array.from(bytes));
      }
      return Promise.resolve({ key: sha256, sha256, size: bytes.byteLength });
    },

    get(key, sha256) {
      try {
        assertKey(key);
        const held = files.get(key);
        if (held === undefined) throw new StorageError('missing', 'No stored file at this key');
        assertIntact(held, sha256);
        return Promise.resolve(Uint8Array.from(held));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    keys: () => [...files.keys()],

    corrupt(key) {
      const held = files.get(key);
      if (held === undefined) throw new StorageError('missing', 'No stored file at this key');
      const changed = held.byteLength === 0 ? Uint8Array.of(0) : Uint8Array.from(held);
      changed[0] = (changed[0] ?? 0) ^ 0xff;
      files.set(key, changed);
    },
  };
}
