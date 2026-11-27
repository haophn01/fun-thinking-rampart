import { verify as argon2Verify } from '@node-rs/argon2';
import { pbkdf2, pbkdf2Sync, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DUMMY_HASH,
  DUMMY_PBKDF2_HASH,
  PBKDF2_ITERATIONS,
  hashPassword,
  passwordSchemeFor,
  verifyPassword,
} from './password';

// The real functions, wrapped so a test can see which hash work a verify spent.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, pbkdf2: vi.fn(actual.pbkdf2) };
});
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@node-rs/argon2')>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

afterEach(() => {
  vi.clearAllMocks();
});

const PASSWORD = 'a long enough passphrase';
const PBKDF2_FORMAT = /^\$pbkdf2-sha256\$i=600000\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

/** A PBKDF2 hash built by hand, so a test can pick any part of it. */
function craft(password: string, iterations: number, salt = randomBytes(16), keyLength = 32) {
  const key = pbkdf2Sync(password, salt, iterations, keyLength, 'sha256');
  return `$pbkdf2-sha256$i=${String(iterations)}$${b64(salt)}$${b64(key)}`;
}

describe('pbkdf2-sha256 hashes and verifies', () => {
  it('a pbkdf2 hash matches the format with i=600000, verifies, and refuses a wrong password', async () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    const stored = await hashPassword(PASSWORD, 'pbkdf2-sha256');
    expect(stored).toMatch(PBKDF2_FORMAT);
    expect(await verifyPassword(stored, PASSWORD, 'pbkdf2-sha256')).toBe(true);
    expect(await verifyPassword(stored, `${PASSWORD} `, 'pbkdf2-sha256')).toBe(false);
    expect(await verifyPassword(stored, 'something else entirely', 'pbkdf2-sha256')).toBe(false);
  });

  it('two hashes of one password differ', async () => {
    const [a, b] = await Promise.all([
      hashPassword(PASSWORD, 'pbkdf2-sha256'),
      hashPassword(PASSWORD, 'pbkdf2-sha256'),
    ]);
    expect(a).not.toBe(b);
    expect(a.split('$')[3]).not.toBe(b.split('$')[3]);
  });

  it('a hash made elsewhere with the same parameters verifies, as does the lowest allowed count', async () => {
    expect(await verifyPassword(craft(PASSWORD, 600_000), PASSWORD)).toBe(true);
    expect(await verifyPassword(craft(PASSWORD, 100_000), PASSWORD)).toBe(true);
  });

  it('argon2id stays the default scheme', async () => {
    expect(await hashPassword(PASSWORD)).toMatch(/^\$argon2id\$/);
    expect(await hashPassword(PASSWORD, 'argon2id')).toMatch(/^\$argon2id\$/);
  });

  it('the scheme follows FIPS_MODE: pbkdf2 only when required', () => {
    expect(passwordSchemeFor({ fipsMode: 'off' })).toBe('argon2id');
    expect(passwordSchemeFor({ fipsMode: 'required' })).toBe('pbkdf2-sha256');
  });
});

describe('refuses malformed pbkdf2 hashes without throwing', () => {
  it('i=0, 99999, 10000001, i=abc, a 15-byte salt, a 31-byte key, bad base64 and an unknown prefix each give false', async () => {
    const good = await hashPassword(PASSWORD, 'pbkdf2-sha256');
    const [, , , salt, key] = good.split('$');
    const withIterations = (i: string) => `$pbkdf2-sha256$i=${i}$${salt ?? ''}$${key ?? ''}`;
    const malformed = [
      withIterations('0'),
      // A count just under the floor, its key computed at that count: only the bound refuses it.
      craft(PASSWORD, 99_999),
      withIterations('10000001'),
      withIterations('abc'),
      withIterations(''),
      withIterations('-600000'),
      withIterations('600000.0'),
      withIterations(' 600000'),
      craft(PASSWORD, 100_000, randomBytes(15)),
      craft(PASSWORD, 100_000, randomBytes(16), 31),
      craft(PASSWORD, 100_000, randomBytes(16), 33),
      `$pbkdf2-sha256$i=600000$${salt ?? ''}$${(key ?? '').slice(0, -1)}*`,
      `$pbkdf2-sha256$i=600000$${salt ?? ''}==$${key ?? ''}`,
      `$pbkdf2-sha256$i=600000$${salt ?? ''}$${key ?? ''}=`,
      `$pbkdf2-sha256$i=600000$${salt ?? ''}$${key ?? ''}$extra`,
      `$pbkdf2-sha256$i=600000$${salt ?? ''}`,
      `$pbkdf2-sha256$600000$${salt ?? ''}$${key ?? ''}`,
      good.replace('$pbkdf2-sha256$', '$pbkdf2-sha512$'),
      good.replace('$pbkdf2-sha256$', '$PBKDF2-SHA256$'),
      `$bcrypt$${good}`,
      'plaintext',
      '',
    ];
    for (const stored of malformed) {
      for (const scheme of ['argon2id', 'pbkdf2-sha256'] as const) {
        await expect(verifyPassword(stored, PASSWORD, scheme), stored).resolves.toBe(false);
      }
    }
  });
});

describe('verifies either scheme whatever the mode', () => {
  it('an argon2 hash verifies under scheme pbkdf2 and a pbkdf2 hash under argon2', async () => {
    const argon = await hashPassword(PASSWORD, 'argon2id');
    const pbkdf = await hashPassword(PASSWORD, 'pbkdf2-sha256');
    expect(await verifyPassword(argon, PASSWORD, 'pbkdf2-sha256')).toBe(true);
    expect(await verifyPassword(pbkdf, PASSWORD, 'argon2id')).toBe(true);
    expect(await verifyPassword(argon, 'wrong password here', 'pbkdf2-sha256')).toBe(false);
    expect(await verifyPassword(pbkdf, 'wrong password here', 'argon2id')).toBe(false);
  });
});

describe("an unknown user spends the mode's hash time", () => {
  it('null stored returns false and runs the pbkdf2 dummy when the scheme is pbkdf2 (spy)', async () => {
    expect(DUMMY_PBKDF2_HASH).toMatch(PBKDF2_FORMAT);
    expect(await verifyPassword(null, PASSWORD, 'pbkdf2-sha256')).toBe(false);
    expect(vi.mocked(pbkdf2)).toHaveBeenCalledTimes(1);
    const [, salt, iterations, keyLength, digest] = vi.mocked(pbkdf2).mock.calls[0] ?? [];
    expect(b64(Buffer.from(salt as Buffer))).toBe(DUMMY_PBKDF2_HASH.split('$')[3]);
    expect([iterations, keyLength, digest]).toEqual([600_000, 32, 'sha256']);
    expect(vi.mocked(argon2Verify)).not.toHaveBeenCalled();
  });

  it('null stored runs the argon2 dummy under the default scheme', async () => {
    expect(await verifyPassword(null, PASSWORD)).toBe(false);
    expect(vi.mocked(argon2Verify)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(argon2Verify).mock.calls[0]?.[0]).toBe(DUMMY_HASH);
    expect(vi.mocked(pbkdf2)).not.toHaveBeenCalled();
  });

  it('the pbkdf2 dummy matches no password anyone would type', async () => {
    expect(await verifyPassword(DUMMY_PBKDF2_HASH, '')).toBe(false);
    expect(await verifyPassword(DUMMY_PBKDF2_HASH, PASSWORD)).toBe(false);
  });
});
