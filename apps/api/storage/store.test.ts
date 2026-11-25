import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalStore, createMemoryStore, StorageError, type FileStore } from '.';

/** The NIST FIPS 180-2 SHA-256 test vector for "abc". */
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const ABC = new TextEncoder().encode('abc');
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const scratch: string[] = [];

async function scratchDir(prefix = 'rampart-store-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Every file under `dir`, as paths relative to it with forward slashes. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .replace(/\\/g, '/'),
    )
    .sort();
}

async function storageError(promise: Promise<unknown>): Promise<StorageError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageError) return error;
    throw error;
  }
  throw new Error('expected a StorageError');
}

interface Subject {
  name: string;
  make: () => Promise<{ store: FileStore; root: string | null }>;
}

const subjects: Subject[] = [
  {
    name: 'local',
    async make() {
      const root = join(await scratchDir(), 'files');
      return { store: createLocalStore(root), root };
    },
  },
  {
    name: 'memory',
    make() {
      return Promise.resolve({ store: createMemoryStore(), root: null });
    },
  },
];

describe.each(subjects)('$name store', ({ make }) => {
  it('round trip', async () => {
    const { store } = await make();
    const stored = await store.put(ABC);
    expect(stored).toEqual({ key: ABC_SHA256, sha256: ABC_SHA256, size: 3 });
    const bytes = await store.get(stored.key, stored.sha256);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual(Array.from(ABC));
  });

  it('round trips empty and binary bytes', async () => {
    const { store } = await make();
    expect(await store.put(new Uint8Array())).toEqual({
      key: EMPTY_SHA256,
      sha256: EMPTY_SHA256,
      size: 0,
    });
    const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
    const stored = await store.put(binary);
    expect(stored.size).toBe(256);
    expect(Array.from(await store.get(stored.key, stored.sha256))).toEqual(Array.from(binary));
  });

  it('keeps its own copy of the bytes', async () => {
    const { store } = await make();
    const input = Uint8Array.from(ABC);
    await store.put(input);
    input[0] = 0;
    const first = await store.get(ABC_SHA256, ABC_SHA256);
    first[0] = 0;
    expect(Array.from(await store.get(ABC_SHA256, ABC_SHA256))).toEqual(Array.from(ABC));
  });

  it('integrity: a wrong expected sha256 gives integrity', async () => {
    const { store } = await make();
    await store.put(ABC);
    const wrong = EMPTY_SHA256;
    expect((await storageError(store.get(ABC_SHA256, wrong))).kind).toBe('integrity');
    expect((await storageError(store.get(ABC_SHA256, 'not-a-hash'))).kind).toBe('integrity');
  });

  it('integrity: an unknown key gives missing', async () => {
    const { store } = await make();
    const error = await storageError(store.get(ABC_SHA256, ABC_SHA256));
    expect(error.kind).toBe('missing');
    expect(error.name).toBe('StorageError');
  });

  it('key validation', async () => {
    const { store } = await make();
    await store.put(ABC);
    const bad = ['../x', ABC_SHA256.toUpperCase(), ABC_SHA256.slice(0, 63), `${ABC_SHA256}0`, ''];
    for (const key of bad) {
      const error = await storageError(store.get(key, ABC_SHA256));
      expect(error.kind, key).toBe('invalid_key');
    }
  });

  it('concurrent puts of the same bytes both succeed', async () => {
    const { store } = await make();
    const results = await Promise.all([store.put(ABC), store.put(ABC), store.put(ABC)]);
    for (const result of results) expect(result.key).toBe(ABC_SHA256);
    expect(Array.from(await store.get(ABC_SHA256, ABC_SHA256))).toEqual(Array.from(ABC));
  });
});

describe('local store', () => {
  it('content-addressed and atomic', async () => {
    const root = join(await scratchDir(), 'files');
    const store = createLocalStore(root);
    const first = await store.put(ABC);
    const second = await store.put(Uint8Array.from(ABC));
    expect(second).toEqual(first);
    expect(await filesUnder(root)).toEqual([`ba/${ABC_SHA256}`]);
    expect(await readdir(join(root, 'tmp'))).toEqual([]);
    expect(Array.from(await readFile(join(root, 'ba', ABC_SHA256)))).toEqual(Array.from(ABC));
  });

  it('replaces a file at the key whose hash is wrong', async () => {
    const root = join(await scratchDir(), 'files');
    const store = createLocalStore(root);
    await store.put(ABC);
    await writeFile(join(root, 'ba', ABC_SHA256), 'tampered');
    await store.put(ABC);
    expect(Array.from(await store.get(ABC_SHA256, ABC_SHA256))).toEqual(Array.from(ABC));
    expect(await filesUnder(root)).toEqual([`ba/${ABC_SHA256}`]);
  });

  it('a failed write leaves nothing at the key and no temp file', async () => {
    const root = join(await scratchDir(), 'files');
    const store = createLocalStore(root);
    // A plain file where the key's folder must go makes the move into place fail.
    await store.put(new TextEncoder().encode('seed'));
    await writeFile(join(root, 'ba'), 'in the way');
    await expect(store.put(ABC)).rejects.toThrow();
    expect(await readdir(join(root, 'tmp'))).toEqual([]);
    expect((await stat(join(root, 'ba'))).isFile()).toBe(true);
    expect((await storageError(store.get(ABC_SHA256, ABC_SHA256))).kind).toBe('missing');
  });

  it('integrity', async () => {
    const root = join(await scratchDir(), 'files');
    const store = createLocalStore(root);
    await store.put(ABC);
    const path = join(root, 'ba', ABC_SHA256);

    await writeFile(path, 'abd');
    expect((await storageError(store.get(ABC_SHA256, ABC_SHA256))).kind).toBe('integrity');

    await unlink(path);
    expect((await storageError(store.get(ABC_SHA256, ABC_SHA256))).kind).toBe('missing');

    await store.put(ABC);
    expect((await storageError(store.get(ABC_SHA256, EMPTY_SHA256))).kind).toBe('integrity');
  });

  it('key validation touches nothing outside the root', async () => {
    const parent = await scratchDir();
    const root = join(parent, 'files');
    const store = createLocalStore(root);
    // A file one level up, reachable by a naive path join of "../x".
    await writeFile(join(parent, 'x'), 'abc');
    const before = await filesUnder(parent);
    for (const key of ['../x', '..\\x', ABC_SHA256.toUpperCase(), ABC_SHA256.slice(0, 63)]) {
      expect((await storageError(store.get(key, ABC_SHA256))).kind, key).toBe('invalid_key');
    }
    expect(await filesUnder(parent)).toEqual(before);
    // Not even the root was created.
    await expect(stat(root)).rejects.toThrow();
  });

  it('creates its root', async () => {
    const parent = await scratchDir('rampart store with spaces ');
    const root = join(parent, 'evidence files', 'nested deeper');
    const store = createLocalStore(root);
    await expect(stat(root)).rejects.toThrow();
    const stored = await store.put(ABC);
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(Array.from(await store.get(stored.key, stored.sha256))).toEqual(Array.from(ABC));
  });

  it('a missing root reads as missing, not as an error of its own', async () => {
    const root = join(await scratchDir(), 'never-created');
    const store = createLocalStore(root);
    expect((await storageError(store.get(ABC_SHA256, ABC_SHA256))).kind).toBe('missing');
  });
});

describe('memory store', () => {
  it('lists keys and corrupts one for tests', async () => {
    const store = createMemoryStore();
    expect(store.keys()).toEqual([]);
    await store.put(ABC);
    await store.put(ABC);
    await store.put(new TextEncoder().encode('seed'));
    expect(store.keys()).toHaveLength(2);
    expect(store.keys()).toContain(ABC_SHA256);

    store.corrupt(ABC_SHA256);
    expect((await storageError(store.get(ABC_SHA256, ABC_SHA256))).kind).toBe('integrity');
    // A later put of the right bytes repairs it, as on disk.
    await store.put(ABC);
    expect(Array.from(await store.get(ABC_SHA256, ABC_SHA256))).toEqual(Array.from(ABC));
  });

  it('corrupting an unknown key throws missing', () => {
    const store = createMemoryStore();
    expect(() => {
      store.corrupt(ABC_SHA256);
    }).toThrow(StorageError);
  });

  it('corrupts an empty file too', async () => {
    const store = createMemoryStore();
    await store.put(new Uint8Array());
    store.corrupt(EMPTY_SHA256);
    expect((await storageError(store.get(EMPTY_SHA256, EMPTY_SHA256))).kind).toBe('integrity');
  });
});
