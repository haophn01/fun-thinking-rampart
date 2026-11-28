import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BLOCKLIST_MAX_LENGTH,
  BLOCKLIST_MIN_LENGTH,
  buildBlocklist,
  filterPasswords,
  parseBuildArgs,
} from '../../scripts/build-blocklist.ts';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'build-blocklist.ts');
const SOURCE = 'https://example.test/list.txt';

/** Joins byte chunks (strings are UTF-8 encoded) into one buffer. */
function bytes(...parts: (string | number[])[]): Uint8Array {
  return Buffer.concat(
    parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part))),
  );
}

function lines(...entries: string[]): Uint8Array {
  return bytes(entries.join('\n') + '\n');
}

const TWELVE = 'abcdefghijkl';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('build-blocklist', () => {
  it('builds the list deterministically', () => {
    const input = bytes(
      'zzzzzzzzzzzz\n',
      'short-11chr\n',
      `${TWELVE}\n`,
      `${'m'.repeat(128)}\n`,
      `${'n'.repeat(129)}\n`,
      'Password1234\n',
      'PASSWORD1234\n',
      'password1234\n',
      'tab\there12345\n',
      'nul\u0000here12345\n',
      'del\u007fhere12345\n',
      'c1\u0085here123456\n',
      'replacement\ufffdchar\n',
      'bad-utf8-',
      [0xff, 0xfe],
      '-here\n',
      'crlf-line-1234\r\n',
      ' leading-space1\n',
      '\n',
      'no-final-newline',
    );

    const kept = filterPasswords(input);
    expect(kept).toEqual([
      ' leading-space1',
      TWELVE,
      'crlf-line-1234',
      'm'.repeat(128),
      'no-final-newline',
      'password1234',
      'zzzzzzzzzzzz',
    ]);

    const json = buildBlocklist(input, SOURCE);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['source', 'sha256', 'count', 'passwords']);
    expect(parsed).toEqual({
      source: SOURCE,
      sha256: createHash('sha256').update(input).digest('hex'),
      count: kept.length,
      passwords: kept,
    });
    expect(json.endsWith('\n')).toBe(true);
    expect(buildBlocklist(input, SOURCE)).toBe(json);

    // The order of the input doesn't change the output.
    const shuffled = lines('password1234', TWELVE, 'Password1234');
    const again = lines('PASSWORD1234', 'password1234', TWELVE);
    expect(filterPasswords(shuffled)).toEqual(filterPasswords(again));
  });

  it('keeps exactly the lengths the password policy accepts', () => {
    expect(BLOCKLIST_MIN_LENGTH).toBe(12);
    expect(BLOCKLIST_MAX_LENGTH).toBe(128);
    expect(filterPasswords(lines('a'.repeat(11), 'b'.repeat(12)))).toEqual(['b'.repeat(12)]);
    expect(filterPasswords(lines('c'.repeat(128), 'd'.repeat(129)))).toEqual(['c'.repeat(128)]);
    // Length counts UTF-16 units, as the policy's zod string does: 6 surrogate pairs is 12.
    expect(filterPasswords(lines('\u{1F600}'.repeat(6), '\u{1F600}'.repeat(5)))).toEqual([
      '\u{1F600}'.repeat(6),
    ]);
  });

  it('drops a byte-order mark and an empty input gives an empty list', () => {
    expect(filterPasswords(bytes([0xef, 0xbb, 0xbf], 'bom-at-start-1\n'))).toEqual([
      'bom-at-start-1',
    ]);
    expect(filterPasswords(new Uint8Array())).toEqual([]);
    expect(JSON.parse(buildBlocklist(new Uint8Array(), SOURCE))).toMatchObject({
      count: 0,
      passwords: [],
    });
  });

  it('writes byte-identical files when run twice from the command line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-blocklist-'));
    tempDirs.push(dir);
    const input = join(dir, 'list.txt');
    writeFileSync(input, lines('Zebra-crossing-12', 'apple-pie-1234', 'short', 'APPLE-PIE-1234'));
    const outputs = ['one.json', 'two.json'].map((name) => {
      const out = join(dir, name);
      const run = spawnSync(process.execPath, [script, input, '--out', out, '--source', SOURCE], {
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('kept 2 of 4');
      return readFileSync(out);
    });
    expect(outputs[0]?.equals(outputs[1] ?? Buffer.alloc(0))).toBe(true);
    expect(JSON.parse(outputs[0]?.toString('utf8') ?? '')).toMatchObject({
      count: 2,
      passwords: ['apple-pie-1234', 'zebra-crossing-12'],
    });
  });

  it('parses its arguments and refuses a missing file', () => {
    expect(parseBuildArgs(['list.txt'])).toMatchObject({ file: 'list.txt' });
    expect(parseBuildArgs(['list.txt', '--out', 'o.json', '--source', 'u'])).toEqual({
      file: 'list.txt',
      out: 'o.json',
      source: 'u',
    });
    expect(() => parseBuildArgs([])).toThrow(/usage/i);
    expect(() => parseBuildArgs(['a', 'b'])).toThrow(/usage/i);
    expect(() => parseBuildArgs(['a', '--out'])).toThrow(/usage/i);
    expect(() => parseBuildArgs(['a', '--bogus', 'x'])).toThrow(/usage/i);
  });
});
