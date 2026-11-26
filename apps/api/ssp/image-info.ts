// What an embedded diagram is and how big it draws, read from its own bytes: a PNG's IHDR or a
// JPEG's frame marker. Parsed by hand, so the export needs no image library.

export interface ImageInfo {
  /** From the bytes, never the file name. */
  type: 'png' | 'jpg';
  width: number;
  height: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** The text width of a US Letter page with one-inch margins: 6.5 in at 96 dpi. */
export const IMAGE_MAX_WIDTH = 624;
/** 9 in at 96 dpi, so a tall diagram still fits the page with its caption. */
export const IMAGE_MAX_HEIGHT = 864;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** "IHDR" in ASCII. */
const IHDR = [0x49, 0x48, 0x44, 0x52];

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((byte, i) => bytes[at + i] === byte);
}

function sized(type: ImageInfo['type'], width: number, height: number): ImageInfo | null {
  return width > 0 && height > 0 ? { type, width, height } : null;
}

function pngInfo(bytes: Uint8Array): ImageInfo | null {
  // Signature (8), chunk length (4), "IHDR" (4), width (4), height (4).
  if (bytes.length < 24 || !startsWith(bytes, IHDR, 12)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return sized('png', view.getUint32(16), view.getUint32(20));
}

/** SOF0-SOF15, but DHT (C4), JPG (C8) and DAC (CC), which share the range and aren't frames. */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Markers that stand alone, with no length: TEM and RST0-RST7. */
function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function jpegInfo(bytes: Uint8Array): ImageInfo | null {
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    // Any number of 0xFF fill bytes may come before a marker.
    while (bytes[at] === 0xff) at += 1;
    const marker = bytes[at];
    if (marker === undefined) return null;
    at += 1;
    if (isStandalone(marker)) continue;
    // End of image or start of scan before any frame: there is no size to read.
    if (marker === 0xd9 || marker === 0xda) return null;
    const hi = bytes[at];
    const lo = bytes[at + 1];
    if (hi === undefined || lo === undefined) return null;
    const length = (hi << 8) | lo;
    if (length < 2) return null;
    if (isFrameMarker(marker)) {
      // The whole frame header must be there: length (2), precision (1), height (2), width (2), ...
      if (length < 8 || at + length > bytes.length) return null;
      const height = ((bytes[at + 3] ?? 0) << 8) | (bytes[at + 4] ?? 0);
      const width = ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0);
      return sized('jpg', width, height);
    }
    at += length;
  }
  return null;
}

/**
 * The image's type and pixel size, from a PNG's IHDR or a JPEG's SOFn marker (baseline or
 * progressive). Truncated data, a zero size or any other format gives null.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return pngInfo(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegInfo(bytes);
  return null;
}

/**
 * The size an image draws at: 624 px wide with its aspect ratio kept, unless that is taller than
 * 864 px, when the height caps and the width shrinks to match. Whole pixels, at least 1.
 */
export function fitImage(size: ImageSize): ImageSize {
  const scale = Math.min(IMAGE_MAX_WIDTH / size.width, IMAGE_MAX_HEIGHT / size.height);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}
