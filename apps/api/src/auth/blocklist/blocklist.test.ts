import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isBlocklisted } from './index';

interface BundledList {
  source: string;
  sha256: string;
  count: number;
  passwords: string[];
}

const here = new URL('./', import.meta.url);
const bundled = JSON.parse(
  readFileSync(new URL('common-passwords.json', here), 'utf8'),
) as BundledList;
const sources = readFileSync(new URL('SOURCES.md', here), 'utf8');

describe('password blocklist', () => {
  it('blocks listed passwords case-insensitively', () => {
    for (const listed of ['password1234', 'PassWord1234', 'PASSWORD1234', 'QwertyUiop12']) {
      expect(isBlocklisted(listed), listed).toBe(true);
    }
    for (const unlisted of ['zq8#Lw2!pT9v', 'correct horse battery', '']) {
      expect(isBlocklisted(unlisted), unlisted).toBe(false);
    }
    // Only exact matches count: no substring, superstring, padding or trimming.
    for (const near of ['password1234!', 'assword12345', ' password1234', 'password1234 ']) {
      expect(isBlocklisted(near), JSON.stringify(near)).toBe(false);
    }
    // Every bundled entry is refused, upper-cased too.
    const sample = bundled.passwords.filter((_, i) => i % 997 === 0);
    expect(sample.length).toBeGreaterThan(40);
    for (const entry of sample) {
      expect(isBlocklisted(entry), entry).toBe(true);
      expect(isBlocklisted(entry.toUpperCase()), entry).toBe(true);
    }
  });

  it('bundled list is well-formed', () => {
    expect(bundled.count).toBe(bundled.passwords.length);
    expect(bundled.count).toBeGreaterThan(10_000);
    expect(bundled.sha256).toMatch(/^[0-9a-f]{64}$/);
    // eslint-disable-next-line no-control-regex
    const unwanted = /[\u0000-\u001f\u007f-\u009f\ufffd]/u;
    let previous: string | undefined;
    for (const entry of bundled.passwords) {
      expect(typeof entry).toBe('string');
      expect(entry.length, entry).toBeGreaterThanOrEqual(12);
      expect(entry.length, entry).toBeLessThanOrEqual(128);
      expect(entry, entry).toBe(entry.toLowerCase());
      expect(unwanted.test(entry), JSON.stringify(entry)).toBe(false);
      // Strictly increasing by UTF-16 code unit: sorted and unique in one check.
      if (previous !== undefined) expect(previous < entry, `${previous} < ${entry}`).toBe(true);
      previous = entry;
    }
  });

  it('source and licence are recorded', () => {
    expect(sources).toMatch(/\bMIT\b/);
    expect(sources).toContain(bundled.source);
    expect(sources).toContain(bundled.sha256);
    const kept = /kept count[^0-9]*([0-9][0-9,]*)/i.exec(sources);
    expect(kept, 'SOURCES.md names a kept count').not.toBeNull();
    expect(Number(kept?.[1]?.replaceAll(',', ''))).toBe(bundled.count);
  });
});
