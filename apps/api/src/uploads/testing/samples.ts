// Sample upload files, built in code so no binary fixture is committed. Plain Node with no test
// framework import, so the e2e specs can use them too. Every sample is deterministic.
import { crc32, deflateRawSync } from 'node:zlib';
import { pngOf } from '../../../ssp/testing/docx-text';

const encoder = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Little-endian fields, as zip writes them. */
function le(...fields: readonly (readonly [bytes: 2 | 4, value: number])[]): Uint8Array {
  const out = new Uint8Array(fields.reduce((sum, [bytes]) => sum + bytes, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [bytes, value] of fields) {
    if (bytes === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
    at += bytes;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Zip

export interface ZipEntryInput {
  name: string;
  data: Uint8Array | string;
  /** Default `deflate`. */
  method?: 'store' | 'deflate';
}

export interface ZipOptions {
  /** Sets the encrypted flag (bit 0) on every entry. The data stays plain. */
  encrypted?: boolean;
  /** Declares this uncompressed size for every entry instead of the real one. */
  declaredSize?: number;
  /** The archive comment, which pads the file without adding to what it expands to. */
  comment?: string;
}

// 1980-01-01 00:00, the earliest DOS date, so the bytes never depend on the clock.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/** A zip file of `entries`, in order, with UTF-8 names. */
export function zipOf(entries: readonly ZipEntryInput[], options: ZipOptions = {}): Uint8Array {
  const flags = 0x0800 | (options.encrypted === true ? 1 : 0);
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const stored = entry.method === 'store';
    const data = stored ? raw : new Uint8Array(deflateRawSync(raw));
    const crc = crc32(raw);
    const size = options.declaredSize ?? raw.length;
    const shared = le(
      [2, 20],
      [2, flags],
      [2, stored ? 0 : 8],
      [2, DOS_TIME],
      [2, DOS_DATE],
      [4, crc],
      [4, data.length],
      [4, size],
      [2, name.length],
      [2, 0],
    );
    const local = concat([le([4, 0x04034b50]), shared, name, data]);
    central.push(
      concat([
        le([4, 0x02014b50], [2, 20]),
        shared,
        le([2, 0], [2, 0], [2, 0], [4, 0], [4, offset]),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const directory = concat(central);
  const comment = encoder.encode(options.comment ?? '');
  const end = le(
    [4, 0x06054b50],
    [2, 0],
    [2, 0],
    [2, entries.length],
    [2, entries.length],
    [4, directory.length],
    [4, offset],
    [2, comment.length],
  );
  return concat([...locals, directory, end, comment]);
}

// ---------------------------------------------------------------------------------------------
// Office files

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_DOC_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const DEFAULTS =
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>';

function contentTypes(overrides: Record<string, string>): string {
  const parts = Object.entries(overrides)
    .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
    .join('');
  return `${XML_HEAD}<Types xmlns="${CONTENT_TYPES_NS}">${DEFAULTS}${parts}</Types>`;
}

function relationships(rels: Record<string, readonly [type: string, target: string]>): string {
  const items = Object.entries(rels)
    .map(([id, [type, target]]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
    .join('');
  return `${XML_HEAD}<Relationships xmlns="${RELS_NS}">${items}</Relationships>`;
}

/** The parts of a minimal valid .docx, for tests that build variants of it. */
export function docxEntries(): ZipEntryInput[] {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return [
    {
      name: '[Content_Types].xml',
      data: contentTypes({
        '/word/document.xml':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      }),
    },
    { name: '_rels/.rels', data: relationships({ rId1: [OFFICE_DOC_REL, 'word/document.xml'] }) },
    {
      name: 'word/document.xml',
      data:
        `${XML_HEAD}<w:document xmlns:w="${w}"><w:body>` +
        '<w:p><w:r><w:t>Rampart sample document</w:t></w:r></w:p></w:body></w:document>',
    },
  ];
}

/** The parts of a minimal valid .xlsx, for tests that build variants of it. */
export function xlsxEntries(): ZipEntryInput[] {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return [
    {
      name: '[Content_Types].xml',
      data: contentTypes({
        '/xl/workbook.xml':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
        '/xl/worksheets/sheet1.xml':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
      }),
    },
    { name: '_rels/.rels', data: relationships({ rId1: [OFFICE_DOC_REL, 'xl/workbook.xml'] }) },
    {
      name: 'xl/workbook.xml',
      data:
        `${XML_HEAD}<workbook xmlns="${main}" xmlns:r="${r}">` +
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: relationships({ rId1: [`${r}/worksheet`, 'worksheets/sheet1.xml'] }),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        `${XML_HEAD}<worksheet xmlns="${main}"><sheetData><row r="1">` +
        '<c r="A1" t="inlineStr"><is><t>Rampart sample</t></is></c></row></sheetData></worksheet>',
    },
  ];
}

/** A minimal valid Word document. */
export function sampleDocx(): Uint8Array {
  return zipOf(docxEntries());
}

/** A minimal valid Excel workbook. */
export function sampleXlsx(): Uint8Array {
  return zipOf(xlsxEntries());
}

/** `sampleDocx` plus a 20 MiB part of zeros, deflated: well over 100 times its own size. */
export function zipBombDocx(): Uint8Array {
  return zipOf([
    ...docxEntries(),
    { name: 'word/media/zeros.bin', data: new Uint8Array(20 * 1024 * 1024) },
  ]);
}

// ---------------------------------------------------------------------------------------------
// PDF and images

/** A minimal valid one-page PDF with a correct xref table. */
export function samplePdf(): Uint8Array {
  const content = 'BT /F1 18 Tf 20 100 Td (Rampart sample) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n`;
  pdf += `startxref\n${String(xrefAt)}\n%%EOF\n`;
  return encoder.encode(pdf);
}

/** A valid 2 x 2 greyscale PNG. */
export function samplePng(): Uint8Array {
  return pngOf(2, 2);
}

function segment(marker: number, data: readonly number[]): number[] {
  const length = data.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...data];
}

/**
 * A decodable 1 x 1 grey baseline JPEG: one quantization table, one-code Huffman tables and a
 * single block whose DC difference is 0 and whose AC is an immediate end-of-block.
 */
export function sampleJpeg(): Uint8Array {
  const jfif = [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const oneCode = [1, ...new Array<number>(15).fill(0), 0x00];
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe0, jfif),
    ...segment(0xdb, [0x00, ...new Array<number>(64).fill(1)]),
    ...segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...segment(0xc4, [0x00, ...oneCode]),
    ...segment(0xc4, [0x10, ...oneCode]),
    ...segment(0xda, [1, 1, 0x00, 0, 63, 0]),
    // DC code 0 (difference 0), AC code 0 (end of block), padded with ones.
    0x3f,
    0xff,
    0xd9,
  ]);
}

/** An executable's opening: `MZ`, `e_lfanew` pointing at a `PE\0\0` header, then NULs. */
export function fakeExe(): Uint8Array {
  const bytes = new Uint8Array(512);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode('MZ'), 0);
  view.setUint32(0x3c, 0x80, true);
  bytes.set(encoder.encode('PE'), 0x80);
  view.setUint16(0x84, 0x8664, true); // x86-64
  return bytes;
}
