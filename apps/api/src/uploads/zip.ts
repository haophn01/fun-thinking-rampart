// The zip guard for .docx and .xlsx uploads, read by hand with node:zlib. Every step is bounded:
// the directory is parsed once, linear in its size, and nothing is inflated until the declared
// sizes pass the limits, and then never past an entry's declared size.
import { crc32, inflateRawSync } from 'node:zlib';
import { ZIP_LIMITS, type FileRefusedReason } from '../contract/uploads';

export type ZipRefusalReason = Extract<
  FileRefusedReason,
  | 'encrypted'
  | 'zip_too_many_entries'
  | 'zip_too_large'
  | 'zip_ratio'
  | 'zip_malformed'
  | 'zip_unsafe_path'
>;

/** One central-directory record, as declared. */
export interface ZipDirectoryEntry {
  name: string;
  /** The raw name bytes, for the NUL check and the local-header match. */
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export type ZipDirectory =
  | { ok: true; entries: ZipDirectoryEntry[]; directoryOffset: number }
  | { ok: false; reason: 'zip_malformed' };

export type ZipInspection =
  | { ok: true; names: string[]; parts: Map<string, Uint8Array> }
  | { ok: false; reason: ZipRefusalReason };

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
/** The EOCD and the longest comment it may carry. */
const EOCD_SEARCH = EOCD_SIZE + 0xffff;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

const MALFORMED = { ok: false, reason: 'zip_malformed' } as const;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The EOCD's offset: the last signature whose comment ends exactly at the end of the file. */
function findEocd(bytes: Uint8Array, view: DataView): number | null {
  const lowest = Math.max(0, bytes.length - EOCD_SEARCH);
  for (let at = bytes.length - EOCD_SIZE; at >= lowest; at -= 1) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    if (at + EOCD_SIZE + view.getUint16(at + 20, true) === bytes.length) return at;
  }
  return null;
}

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');

/**
 * Step 1 of the guard: find the EOCD and parse the central directory. Refuses (`zip_malformed`)
 * an EOCD that is missing, not on disk 0, ZIP64, or whose directory isn't inside the file or
 * doesn't hold exactly the records it counts. Inflates nothing.
 */
export function readZipDirectory(bytes: Uint8Array): ZipDirectory {
  if (bytes.length < EOCD_SIZE) return MALFORMED;
  const view = viewOf(bytes);
  const eocd = findEocd(bytes, view);
  if (eocd === null) return MALFORMED;

  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const onDisk = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) return MALFORMED;
  if (count === MAX16 || directorySize === MAX32 || directoryOffset === MAX32) return MALFORMED;
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE) return MALFORMED;
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > eocd) return MALFORMED;

  const entries: ZipDirectoryEntry[] = [];
  let at = directoryOffset;
  while (at < directoryEnd) {
    if (at + CENTRAL_SIZE > directoryEnd) return MALFORMED;
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) return MALFORMED;
    const nameLength = view.getUint16(at + 28, true);
    const next =
      at +
      CENTRAL_SIZE +
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
    if (next > directoryEnd) return MALFORMED;
    const flags = view.getUint16(at + 8, true);
    const nameBytes = bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength);
    entries.push({
      name: ((flags & FLAG_UTF8) !== 0 ? utf8 : latin1).decode(nameBytes),
      nameBytes,
      flags,
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    });
    if (view.getUint16(at + 34, true) !== 0) return MALFORMED; // starts on another disk
    at = next;
  }
  if (entries.length !== count) return MALFORMED;
  return { ok: true, entries, directoryOffset };
}

/** A name that could escape the folder it is unpacked into, or isn't a plain relative path. */
function isUnsafeName(entry: ZipDirectoryEntry): boolean {
  const { name } = entry;
  if (entry.nameBytes.includes(0)) return true;
  if (name.startsWith('/') || name.includes('\\')) return true;
  if (/^[a-z]:/i.test(name)) return true;
  return name.split('/').some((segment) => segment === '..');
}

/** Where an entry's data starts, after checking its local header; null when that is damaged. */
function dataStart(bytes: Uint8Array, view: DataView, entry: ZipDirectoryEntry): number | null {
  const at = entry.localOffset;
  if (at + LOCAL_SIZE > bytes.length) return null;
  if (view.getUint32(at, true) !== LOCAL_SIGNATURE) return null;
  const nameLength = view.getUint16(at + 26, true);
  const start = at + LOCAL_SIZE + nameLength + view.getUint16(at + 28, true);
  const local = bytes.subarray(at + LOCAL_SIZE, at + LOCAL_SIZE + nameLength);
  if (local.length !== entry.nameBytes.length || local.some((b, i) => b !== entry.nameBytes[i])) {
    return null;
  }
  return start;
}

/** The entry's bytes, inflated to at most its declared size; null when that isn't what comes out. */
function expand(data: Uint8Array, entry: ZipDirectoryEntry): Uint8Array | null {
  let out: Uint8Array;
  if (entry.method === 0) {
    out = data;
  } else {
    try {
      // maxOutputLength must be at least 1; an empty entry still has to inflate to nothing.
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      return null;
    }
  }
  if (out.length !== entry.size || crc32(out) !== entry.crc) return null;
  return out;
}

/**
 * The zip guard, in the contract's order: the directory (step 1), the entry count, each entry's
 * flags, name, method and sizes, the declared total, the ratio to `bytes.length`, then inflating
 * each entry no further than its declared size and checking its length and CRC. Passing gives the
 * entry names and, for each name in `keep` no larger than `ZIP_LIMITS.maxInflatedPartBytes`, its
 * inflated bytes.
 */
export function inspectZip(bytes: Uint8Array, keep: readonly string[] = []): ZipInspection {
  const directory = readZipDirectory(bytes);
  if (!directory.ok) return directory;
  const { entries } = directory;
  if (entries.length > ZIP_LIMITS.maxEntries) return { ok: false, reason: 'zip_too_many_entries' };

  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) return { ok: false, reason: 'encrypted' };
    if (isUnsafeName(entry)) return { ok: false, reason: 'zip_unsafe_path' };
    if (entry.name === '') return MALFORMED;
    if (entry.method !== 0 && entry.method !== 8) return MALFORMED;
    if (entry.compressedSize === MAX32 || entry.size === MAX32 || entry.localOffset === MAX32) {
      return MALFORMED;
    }
    if (entry.method === 0 && entry.compressedSize !== entry.size) return MALFORMED;
    // Part names compare without case (as OPC and Windows do), so two can't land on one file.
    const key = entry.name.toLowerCase();
    if (seen.has(key)) return MALFORMED;
    seen.add(key);
    total += entry.size;
  }
  if (total > ZIP_LIMITS.maxExpandedBytes) return { ok: false, reason: 'zip_too_large' };
  if (total > ZIP_LIMITS.maxRatio * bytes.length) return { ok: false, reason: 'zip_ratio' };

  const view = viewOf(bytes);
  const wanted = new Set(keep);
  const parts = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const start = dataStart(bytes, view, entry);
    if (start === null || start + entry.compressedSize > directory.directoryOffset) {
      return MALFORMED;
    }
    const out = expand(bytes.subarray(start, start + entry.compressedSize), entry);
    if (out === null) return MALFORMED;
    if (wanted.has(entry.name) && out.length <= ZIP_LIMITS.maxInflatedPartBytes) {
      parts.set(entry.name, out);
    }
  }
  return { ok: true, names: entries.map((entry) => entry.name), parts };
}
