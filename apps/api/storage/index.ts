import { createHash } from 'node:crypto';

/** What `put` reports. The key is the SHA-256 itself, so equal bytes always share one key. */
export interface StoredFile {
  key: string;
  sha256: string;
  size: number;
}

/**
 * Where evidence and policy files live, behind one interface so encryption or other backends can
 * replace the local folder later. Content-addressed: the key is the lowercase hex SHA-256.
 */
export interface FileStore {
  put(bytes: Uint8Array): Promise<StoredFile>; // key === sha256 (lowercase hex)
  get(key: string, sha256: string): Promise<Uint8Array>; // rehashes and compares before returning
}

export type StorageErrorKind = 'missing' | 'integrity' | 'invalid_key';

/** `missing` and `integrity` both reach the client as 500 `file_integrity_failed`. */
export class StorageError extends Error {
  constructor(
    readonly kind: StorageErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

const KEY = /^[0-9a-f]{64}$/;

/** Throws `invalid_key` unless `key` is 64 lowercase hex characters, so it can't name a path. */
export function assertKey(key: string): void {
  if (!KEY.test(key)) throw new StorageError('invalid_key', 'The storage key is not a SHA-256');
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Throws `integrity` unless `bytes` hash to `sha256`. */
export function assertIntact(bytes: Uint8Array, sha256: string): void {
  if (sha256Hex(bytes) !== sha256) {
    throw new StorageError('integrity', "The stored file doesn't match its recorded SHA-256");
  }
}

export { createLocalStore } from './local';
export { createMemoryStore, type MemoryFileStore } from './memory';
