import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZIP_LIMITS } from '../contract/uploads';
import { docxEntries, sampleDocx, zipBombDocx, zipOf, type ZipEntryInput } from './testing/samples';
import { inspectZip, readZipDirectory } from './zip';

// A pass-through spy, so a test can see whether (and how) anything was inflated.
vi.mock('node:zlib', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:zlib')>();
  return { ...real, inflateRawSync: vi.fn(real.inflateRawSync) };
});
const inflate = vi.mocked(inflateRawSync);

afterEach(() => {
  inflate.mockClear();
});

const reasonOf = (bytes: Uint8Array) => {
  const result = inspectZip(bytes);
  return result.ok ? 'ok' : result.reason;
};

/** Offsets in a zip with no archive comment: the EOCD and each central record. */
function layout(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  const records: number[] = [];
  let at = view.getUint32(eocd + 16, true);
  for (let i = 0; i < view.getUint16(eocd + 10, true); i += 1) {
    records.push(at);
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  const locals = records.map((record) => view.getUint32(record + 42, true));
  return { eocd, records, locals };
}

/** A copy of `bytes` with `edit` applied through a little-endian view. */
function patched(
  bytes: Uint8Array,
  edit: (view: DataView, at: ReturnType<typeof layout>) => void,
): Uint8Array {
  const copy = bytes.slice();
  edit(new DataView(copy.buffer), layout(copy));
  return copy;
}

const tiny = (count: number): ZipEntryInput[] =>
  Array.from({ length: count }, (_, i) => ({
    name: `p/${String(i).padStart(4, '0')}.txt`,
    data: 'x',
    method: 'store' as const,
  }));

/** Deterministic bytes that don't compress (xorshift32). */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 0x2545f491;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

/** One deflated part of `size` zeros, padded with a comment so the file is exactly `length` bytes. */
function zerosZip(size: number, length: number): Uint8Array {
  const entries = [{ name: 'zeros.bin', data: new Uint8Array(size) }];
  const bare = zipOf(entries).length;
  expect(length).toBeGreaterThanOrEqual(bare);
  const zip = zipOf(entries, { comment: ' '.repeat(length - bare) });
  expect(zip.length).toBe(length);
  return zip;
}

describe('inspectZip', () => {
  it('accepts a real docx and hands back the parts it was asked to keep', () => {
    const result = inspectZip(sampleDocx(), ['[Content_Types].xml']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.names).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    expect([...result.parts.keys()]).toEqual(['[Content_Types].xml']);
    expect(new TextDecoder().decode(result.parts.get('[Content_Types].xml'))).toContain('<Types');
  });

  it('entry count edge', () => {
    expect(ZIP_LIMITS.maxEntries).toBe(1000);
    expect(reasonOf(zipOf(tiny(1000)))).toBe('ok');
    expect(reasonOf(zipOf(tiny(1001)))).toBe('zip_too_many_entries');
    // The count is judged before any entry: an encrypted 1,001st entry is still "too many".
    expect(reasonOf(zipOf(tiny(1001), { encrypted: true }))).toBe('zip_too_many_entries');
  }, 60_000);

  it('expanded size edge', () => {
    // Enough incompressible bytes that the file is over 1/100 of what it expands to.
    const padding = noise(ZIP_LIMITS.maxExpandedBytes / 100);
    const at = (total: number) =>
      zipOf([
        { name: 'zeros.bin', data: new Uint8Array(total - padding.length) },
        { name: 'noise.bin', data: padding, method: 'store' },
      ]);
    expect(reasonOf(at(104_857_600))).toBe('ok');
    expect(reasonOf(at(104_857_601))).toBe('zip_too_large');
    // Declared sizes alone decide it, before anything is inflated.
    inflate.mockClear();
    expect(reasonOf(zipOf([{ name: 'a.txt', data: 'x' }], { declaredSize: 104_857_601 }))).toBe(
      'zip_too_large',
    );
    expect(inflate).not.toHaveBeenCalled();
  }, 120_000);

  it('ratio edge', () => {
    // 1,000,000 zeros in a file of exactly 10,000 bytes: 100:1.
    expect(reasonOf(zerosZip(1_000_000, 10_000))).toBe('ok');
    expect(reasonOf(zerosZip(1_000_001, 10_000))).toBe('zip_ratio');
    expect(reasonOf(zerosZip(1_000_000, 9_999))).toBe('zip_ratio');

    inflate.mockClear();
    expect(reasonOf(zipBombDocx())).toBe('zip_ratio');
    expect(inflate).not.toHaveBeenCalled();
  }, 60_000);

  it('refuses encrypted, unsafe paths, odd methods, zip64 and damage', () => {
    const docx = sampleDocx();
    expect(reasonOf(zipOf(docxEntries(), { encrypted: true }))).toBe('encrypted');

    for (const name of [
      '../evil.txt',
      'word/../../evil.txt',
      '..',
      '/abs.txt',
      '\\abs.txt',
      'a\\b.txt',
      'C:x.txt',
      'c:/x.txt',
      'a\u0000b.txt',
    ]) {
      expect(reasonOf(zipOf([...docxEntries(), { name, data: 'x' }])), name).toBe(
        'zip_unsafe_path',
      );
    }
    // Dots that aren't a parent segment are fine.
    expect(reasonOf(zipOf([...docxEntries(), { name: 'a/..b/c..txt', data: 'x' }]))).toBe('ok');

    // Method 12 (bzip2) in both headers.
    const method12 = patched(docx, (view, { records, locals }) => {
      view.setUint16((records[0] ?? 0) + 10, 12, true);
      view.setUint16((locals[0] ?? 0) + 8, 12, true);
    });
    expect(reasonOf(method12)).toBe('zip_malformed');

    // ZIP64 markers: in the EOCD's count, its offset, or an entry's size.
    const zip64 = [
      patched(docx, (view, { eocd }) => {
        view.setUint16(eocd + 8, 0xffff, true);
        view.setUint16(eocd + 10, 0xffff, true);
      }),
      patched(docx, (view, { eocd }) => {
        view.setUint32(eocd + 16, 0xffffffff, true);
      }),
      patched(docx, (view, { records }) => {
        view.setUint32((records[1] ?? 0) + 24, 0xffffffff, true);
      }),
      patched(docx, (view, { records }) => {
        view.setUint32((records[1] ?? 0) + 42, 0xffffffff, true);
      }),
    ];
    for (const bytes of zip64) expect(reasonOf(bytes)).toBe('zip_malformed');

    // A truncated EOCD, or none at all.
    expect(reasonOf(docx.subarray(0, docx.length - 5))).toBe('zip_malformed');
    expect(reasonOf(docx.subarray(0, layout(docx).eocd))).toBe('zip_malformed');

    // A bad CRC in both headers.
    const badCrc = patched(docx, (view, { records, locals }) => {
      const crc = view.getUint32((records[2] ?? 0) + 16, true) ^ 1;
      view.setUint32((records[2] ?? 0) + 16, crc, true);
      view.setUint32((locals[2] ?? 0) + 14, crc, true);
    });
    expect(reasonOf(badCrc)).toBe('zip_malformed');

    // A duplicate name, also when only the case differs.
    expect(reasonOf(zipOf([...docxEntries(), { name: 'word/document.xml', data: 'x' }]))).toBe(
      'zip_malformed',
    );
    expect(reasonOf(zipOf([...docxEntries(), { name: 'WORD/Document.xml', data: 'x' }]))).toBe(
      'zip_malformed',
    );

    // The EOCD's count doesn't match the records, either way.
    for (const delta of [1, -1]) {
      const mismatch = patched(docx, (view, { eocd }) => {
        view.setUint16(eocd + 8, 3 + delta, true);
        view.setUint16(eocd + 10, 3 + delta, true);
      });
      expect(reasonOf(mismatch), String(delta)).toBe('zip_malformed');
    }

    // Not on disk 0; a directory outside the file; a local header that names another part.
    const otherDisk = patched(docx, (view, { eocd }) => {
      view.setUint16(eocd + 4, 1, true);
    });
    const outside = patched(docx, (view, { eocd }) => {
      view.setUint32(eocd + 16, docx.length, true);
    });
    const otherName = patched(docx, (view, { locals }) => {
      view.setUint8((locals[2] ?? 0) + 30, 'W'.charCodeAt(0));
    });
    for (const bytes of [otherDisk, outside, otherName])
      expect(reasonOf(bytes)).toBe('zip_malformed');

    // A stored entry whose sizes disagree.
    expect(
      reasonOf(zipOf([{ name: 'a.txt', data: 'abc', method: 'store' }], { declaredSize: 4 })),
    ).toBe('zip_malformed');

    // Not a zip at all.
    expect(reasonOf(new TextEncoder().encode('just text'))).toBe('zip_malformed');
    expect(reasonOf(new Uint8Array())).toBe('zip_malformed');
  });

  it('refuses an entry that inflates past its declared size', () => {
    const data = 'a'.repeat(5000);
    expect(reasonOf(zipOf([{ name: 'a.txt', data }], { declaredSize: 100 }))).toBe('zip_malformed');
    expect(inflate).toHaveBeenCalledTimes(1);
    expect(inflate.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ maxOutputLength: 100 }));
    // The output was capped: inflating stopped instead of returning 5,000 bytes.
    expect(inflate.mock.results[0]?.type).toBe('throw');

    // Less than declared is damage too.
    expect(reasonOf(zipOf([{ name: 'a.txt', data }], { declaredSize: 5001 }))).toBe(
      'zip_malformed',
    );
    // Exactly as declared passes.
    expect(reasonOf(zipOf([{ name: 'a.txt', data }]))).toBe('ok');
  });
});

describe('readZipDirectory', () => {
  it('lists the names without inflating, and refuses damage', () => {
    const result = readZipDirectory(zipBombDocx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map((entry) => entry.name)).toEqual([
        '[Content_Types].xml',
        '_rels/.rels',
        'word/document.xml',
        'word/media/zeros.bin',
      ]);
    }
    expect(inflate).not.toHaveBeenCalled();
    expect(readZipDirectory(new Uint8Array([0x50, 0x4b, 3, 4]))).toEqual({
      ok: false,
      reason: 'zip_malformed',
    });
  });
});
