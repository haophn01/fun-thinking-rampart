import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertIntact, assertKey, sha256Hex, StorageError, type FileStore } from '.';

/** Read failures that mean "no file at this key" rather than a broken disk. */
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** The file's bytes, or null when nothing readable sits at the path. */
async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (NOT_THERE.has(codeOf(error) ?? '')) return null;
    throw error;
  }
}

async function holds(path: string, sha256: string): Promise<boolean> {
  const bytes = await readIfPresent(path);
  return bytes !== null && sha256Hex(bytes) === sha256;
}

/**
 * Files live at `<root>/<first 2 hex>/<sha256>`. Each write goes to `<root>/tmp/` first and is
 * renamed into place, so a reader never sees half a file and a failed write leaves nothing at
 * the key. Nothing is created until the first `put`.
 */
export function createLocalStore(root: string): FileStore {
  const base = resolve(root);
  const tmpDir = join(base, 'tmp');
  const pathOf = (key: string) => join(base, key.slice(0, 2), key);

  return {
    async put(bytes) {
      const sha256 = sha256Hex(bytes);
      const stored = { key: sha256, sha256, size: bytes.byteLength };
      const target = pathOf(sha256);
      // Same bytes already there: nothing to write. A file with the wrong hash is replaced.
      if (await holds(target, sha256)) return stored;

      await mkdir(tmpDir, { recursive: true });
      const tmp = join(tmpDir, `${randomUUID()}.part`);
      try {
        await writeFile(tmp, bytes, { flag: 'wx' });
        await mkdir(join(base, sha256.slice(0, 2)), { recursive: true });
        await rename(tmp, target);
      } catch (error) {
        await rm(tmp, { force: true });
        // A concurrent put of the same bytes may have won the rename (Windows refuses to
        // replace a file another rename is moving); its file is as good as ours.
        if (await holds(target, sha256).catch(() => false)) return stored;
        throw error;
      }
      return stored;
    },

    async get(key, sha256) {
      assertKey(key);
      const bytes = await readIfPresent(pathOf(key));
      if (bytes === null) throw new StorageError('missing', 'No stored file at this key');
      assertIntact(bytes, sha256);
      return bytes;
    },
  };
}
