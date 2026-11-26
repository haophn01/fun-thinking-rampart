// Test helpers: read a .docx back, and build the images a test embeds. fflate is a
// devDependency, so only tests import this file.
import { crc32, deflateSync } from 'node:zlib';
import { strFromU8, unzipSync } from 'fflate';

/** One part of a .docx (a zip file), as text. Throws when the part isn't there. */
export function docxPart(bytes: Uint8Array, path = 'word/document.xml'): string {
  const files = unzipSync(bytes, { filter: (file) => file.name === path });
  const part = files[path];
  if (part === undefined) throw new Error(`The .docx has no ${path}`);
  return strFromU8(part);
}

/** The names of the .docx's embedded media parts (`word/media/*`), sorted. */
export function docxMedia(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, {
    filter: (file) => {
      if (file.name.startsWith('word/media/') && !file.name.endsWith('/')) names.push(file.name);
      return false;
    },
  });
  return names.sort();
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

// A paragraph's start or end, a text run, a tab or a line break, in document order.
const TOKEN =
  /<w:p(?=[\s>/])[^>]*?(\/?)>|<\/w:p>|<w:t(?=[\s>])[^>]*>([^<]*)<\/w:t>|<w:t\s*\/>|<w:tab\/>|<w:br\/>/g;

/**
 * The text of `word/document.xml`: one line per paragraph (table cells are paragraphs too), with
 * tabs and breaks as `\t` and `\n` and XML entities decoded.
 */
export function docxText(bytes: Uint8Array): string {
  const xml = docxPart(bytes);
  const lines: string[] = [];
  let current: string | null = null;
  for (const match of xml.matchAll(TOKEN)) {
    const [token, selfClosing, text] = match;
    if (token.startsWith('<w:p')) {
      if (selfClosing === '/') lines.push('');
      else current = '';
    } else if (token === '</w:p>') {
      if (current !== null) lines.push(current);
      current = null;
    } else if (current !== null) {
      if (token === '<w:tab/>') current += '\t';
      else if (token === '<w:br/>') current += '\n';
      else current += decode(text ?? '');
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Images built by hand, so no fixture file or image library is needed.

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat(new TextEncoder().encode(type), data);
  return concat(u32(data.length), body, u32(crc32(body)));
}

/** A valid, decodable 8-bit greyscale PNG of `width` x `height`. */
export function pngOf(width: number, height: number): Uint8Array {
  const header = concat(u32(width), u32(height), new Uint8Array([8, 0, 0, 0, 0]));
  // One filter byte (0) per row, then one grey byte per pixel.
  const raw = new Uint8Array(height * (width + 1)).fill(0x80);
  for (let row = 0; row < height; row += 1) raw[row * (width + 1)] = 0;
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  );
}

function segment(marker: number, data: number[]): number[] {
  const length = data.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...data];
}

/**
 * JPEG headers up to its frame: SOI, an APP0 (JFIF) segment, a comment, a fill byte, then SOF0
 * (baseline) or SOF2 (progressive) with the size, then EOI. Enough for a size reader, not a
 * decoder.
 */
export function jpegOf(width: number, height: number, progressive = false): Uint8Array {
  const jfif = [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const frame = [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0];
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe0, jfif),
    ...segment(0xfe, [0x68, 0x69]),
    0xff,
    ...segment(progressive ? 0xc2 : 0xc0, frame),
    0xff,
    0xd9,
  ]);
}
