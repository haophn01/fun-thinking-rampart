import { describe, expect, it } from 'vitest';
import { fitImage, imageInfo } from './image-info';
import { jpegOf, pngOf } from './testing/docx-text';

const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 10, 0, 0, 0, 0]);

describe('imageInfo', () => {
  it('reads sizes', () => {
    expect(imageInfo(pngOf(640, 480))).toEqual({ type: 'png', width: 640, height: 480 });
    expect(imageInfo(pngOf(1, 3000))).toEqual({ type: 'png', width: 1, height: 3000 });
    expect(imageInfo(jpegOf(1200, 800))).toEqual({ type: 'jpg', width: 1200, height: 800 });
    expect(imageInfo(jpegOf(300, 4500, true))).toEqual({ type: 'jpg', width: 300, height: 4500 });
    // Big sizes use all 32 bits of a PNG's IHDR.
    const big = pngOf(2, 2);
    new DataView(big.buffer).setUint32(16, 100_000);
    expect(imageInfo(big)).toEqual({ type: 'png', width: 100_000, height: 2 });

    // The type comes from the bytes: there is no name to go by.
    expect(imageInfo(jpegOf(10, 20))?.type).toBe('jpg');

    // Truncated anywhere: null.
    const png = pngOf(64, 32);
    for (const length of [0, 4, 8, 16, 23]) expect(imageInfo(png.slice(0, length))).toBeNull();
    const jpeg = jpegOf(64, 32);
    // The frame header ends 2 bytes before EOI; any shorter cut can't give a size.
    for (let length = 0; length < jpeg.length - 2; length += 1) {
      expect(imageInfo(jpeg.slice(0, length)), `jpeg cut at ${String(length)}`).toBeNull();
    }
    expect(imageInfo(jpeg.slice(0, jpeg.length - 2))).toEqual({
      type: 'jpg',
      width: 64,
      height: 32,
    });

    // A zero size: null.
    expect(imageInfo(pngOf(0, 10))).toBeNull();
    expect(imageInfo(pngOf(10, 0))).toBeNull();
    expect(imageInfo(jpegOf(0, 10))).toBeNull();
    expect(imageInfo(jpegOf(10, 0))).toBeNull();

    // Any other format, or junk: null.
    expect(imageInfo(GIF)).toBeNull();
    expect(imageInfo(new TextEncoder().encode('%PDF-1.7\n'))).toBeNull();
    expect(imageInfo(new Uint8Array(64))).toBeNull();
    // A PNG signature whose first chunk isn't IHDR.
    const noHeader = pngOf(5, 5);
    noHeader.set(new TextEncoder().encode('IDAT'), 12);
    expect(imageInfo(noHeader)).toBeNull();
    // A JPEG that ends at its start-of-scan before any frame marker.
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toBeNull();
  });

  it('fits the page', () => {
    // Wide images scale to 624 px wide, keeping the aspect ratio.
    expect(fitImage({ width: 1248, height: 600 })).toEqual({ width: 624, height: 300 });
    // Small images scale up to the text width too.
    expect(fitImage({ width: 312, height: 100 })).toEqual({ width: 624, height: 200 });
    expect(fitImage({ width: 624, height: 624 })).toEqual({ width: 624, height: 624 });
    // Tall images cap at 864 px high, and the width shrinks to match.
    expect(fitImage({ width: 1000, height: 2000 })).toEqual({ width: 432, height: 864 });
    expect(fitImage({ width: 1, height: 3000 })).toEqual({ width: 1, height: 864 });
    // Integers, always, and never 0.
    for (const size of [
      { width: 333, height: 777 },
      { width: 1000, height: 3 },
      { width: 7, height: 11 },
      { width: 5000, height: 1 },
    ]) {
      const fitted = fitImage(size);
      expect(Number.isInteger(fitted.width) && Number.isInteger(fitted.height)).toBe(true);
      expect(fitted.width).toBeGreaterThanOrEqual(1);
      expect(fitted.height).toBeGreaterThanOrEqual(1);
      expect(fitted.width).toBeLessThanOrEqual(624);
      expect(fitted.height).toBeLessThanOrEqual(864);
    }
    expect(fitImage({ width: 333, height: 777 })).toEqual({ width: 370, height: 864 });
    expect(fitImage({ width: 1000, height: 3 })).toEqual({ width: 624, height: 2 });
  });
});
