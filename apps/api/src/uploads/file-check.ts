// The upload content check: does an upload's bytes match its extension? Signatures are sniffed by
// hand, text goes through a strict UTF-8 check, and .docx/.xlsx go through the zip guard. Every
// check is linear in the upload's size.
import type { DetectedFileType, FileRefusedReason } from '../contract/uploads';
import { inspectZip, readZipDirectory } from './zip';

export interface FileContentRefusal {
  reason: FileRefusedReason;
  /** What the bytes look like; set only for `content_mismatch`. */
  detected?: DetectedFileType;
}

type Kind = 'pdf' | 'png' | 'jpeg' | 'docx' | 'xlsx' | 'text';

const KIND_BY_EXTENSION: Readonly<Record<string, Kind>> = {
  '.pdf': 'pdf',
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.txt': 'text',
  '.csv': 'text',
};

const CONTENT_TYPES = '[Content_Types].xml';
const MAIN_PART = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml' } as const;

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((byte, i) => bytes[at + i] === byte);
}

const ascii = (value: string): number[] => Array.from(new TextEncoder().encode(value));

const isDigit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;

/** `%PDF-` then a digit, a dot and a digit, at byte 0. */
function isPdf(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, ascii('%PDF-')) && isDigit(bytes[5]) && bytes[6] === 0x2e && isDigit(bytes[7])
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (bytes: Uint8Array) =>
  startsWith(bytes, PNG_SIGNATURE) && startsWith(bytes, ascii('IHDR'), 12);
const isJpeg = (bytes: Uint8Array) => startsWith(bytes, [0xff, 0xd8, 0xff]);
const isZipLocalHeader = (bytes: Uint8Array) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);

const EXECUTABLE_SIGNATURES = [
  ascii('MZ'),
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32, big-endian
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64, big-endian
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32, little-endian
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64, little-endian
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
  ascii('#!'),
];

const ARCHIVE_SIGNATURES = [
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], // Rar!
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x1f, 0x8b], // gzip
  ascii('BZh'), // bzip2
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x50, 0x4b, 0x05, 0x06], // an empty zip
  [0x50, 0x4b, 0x07, 0x08], // a spanned zip
];

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// C0 controls but tab, LF, FF and CR; and DEL.
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;
const MARKUP_START = /^(?:<!doctype|<html|<svg|<\?xml|<script)/i;

/** The upload as text (without a UTF-8 BOM), or null when it isn't plain UTF-8 text. */
function plainText(bytes: Uint8Array): string | null {
  const body = startsWith(bytes, UTF8_BOM) ? bytes.subarray(UTF8_BOM.length) : bytes;
  let text: string;
  try {
    text = decoder.decode(body);
  } catch {
    return null;
  }
  return DISALLOWED_CONTROL.test(text) ? null : text;
}

/** Whether the first byte after a UTF-8 BOM and ASCII whitespace is `<`. */
function startsWithMarkup(bytes: Uint8Array): boolean {
  let at = startsWith(bytes, UTF8_BOM) ? UTF8_BOM.length : 0;
  while (at < bytes.length && [0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[at] ?? 0)) at += 1;
  return bytes[at] === 0x3c;
}

/** docx, xlsx or a plain archive, by the parts a zip holds. */
function officeKindOf(names: readonly string[]): 'docx' | 'xlsx' | 'archive' {
  if (!names.includes(CONTENT_TYPES)) return 'archive';
  if (names.includes(MAIN_PART.docx)) return 'docx';
  if (names.includes(MAIN_PART.xlsx)) return 'xlsx';
  return 'archive';
}

/** What `bytes` look like, by their content alone. Used to word a refusal, never to accept. */
export function detectFileType(bytes: Uint8Array): DetectedFileType {
  if (isPdf(bytes)) return 'pdf';
  if (isPng(bytes)) return 'png';
  if (isJpeg(bytes)) return 'jpeg';
  if (isZipLocalHeader(bytes)) {
    const directory = readZipDirectory(bytes);
    return directory.ok ? officeKindOf(directory.entries.map((entry) => entry.name)) : 'archive';
  }
  if (EXECUTABLE_SIGNATURES.some((signature) => startsWith(bytes, signature))) return 'executable';
  if (ARCHIVE_SIGNATURES.some((signature) => startsWith(bytes, signature))) return 'archive';
  if (startsWith(bytes, ascii('ustar'), 257)) return 'archive';
  if (startsWithMarkup(bytes)) return 'markup';
  if (plainText(bytes) !== null) return 'text';
  return 'unknown';
}

function textProblem(bytes: Uint8Array): FileContentRefusal | null {
  const text = plainText(bytes);
  if (text === null) return { reason: 'not_text' };
  if (MARKUP_START.test(text.trimStart())) return { reason: 'markup_in_text' };
  return null;
}

// Content types may be UTF-8 or UTF-16; dropping NULs from a byte-per-character reading finds an
// ASCII word in either.
const latin1 = new TextDecoder('latin1');
// eslint-disable-next-line no-control-regex
const NULS = /\u0000/g;

function officeProblem(kind: 'docx' | 'xlsx', bytes: Uint8Array): FileContentRefusal | null {
  if (!isZipLocalHeader(bytes))
    return { reason: 'content_mismatch', detected: detectFileType(bytes) };
  const zip = inspectZip(bytes, [CONTENT_TYPES]);
  if (!zip.ok) return { reason: zip.reason };
  if (zip.names.some((name) => name.toLowerCase().endsWith('vbaproject.bin'))) {
    return { reason: 'macro_enabled' };
  }
  if (zip.names.includes(CONTENT_TYPES)) {
    const types = zip.parts.get(CONTENT_TYPES);
    // Present but too big to read: no real content-types part is that large.
    if (types === undefined) return { reason: 'zip_malformed' };
    if (/macroenabled/i.test(latin1.decode(types).replace(NULS, ''))) {
      return { reason: 'macro_enabled' };
    }
  }
  const found = officeKindOf(zip.names);
  return found === kind ? null : { reason: 'content_mismatch', detected: found };
}

/**
 * Whether an upload's bytes are a real file of its extension: null when they are, otherwise the
 * refusal. An extension with no content rule is always refused.
 */
export function checkFileContent(extension: string, bytes: Uint8Array): FileContentRefusal | null {
  const mismatch = (): FileContentRefusal => ({
    reason: 'content_mismatch',
    detected: detectFileType(bytes),
  });
  const kind = KIND_BY_EXTENSION[extension.toLowerCase()];
  switch (kind) {
    case undefined:
      return mismatch();
    case 'pdf':
      return isPdf(bytes) ? null : mismatch();
    case 'png':
      return isPng(bytes) ? null : mismatch();
    case 'jpeg':
      return isJpeg(bytes) ? null : mismatch();
    case 'text':
      return textProblem(bytes);
    case 'docx':
    case 'xlsx':
      return officeProblem(kind, bytes);
  }
}
