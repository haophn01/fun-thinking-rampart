import jsQR from 'jsqr';
import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '../../contract';
import { qrPath } from './qr';
import { otpauthUri } from './totp';

// The contract's shape for `qr.path` (sprint sec-mfa, mfaEnrollmentResponseSchema).
const PATH_RE = /^(M\d{1,3} \d{1,3}h\d{1,3}v1h-\d{1,3}z)*$/;
const RUN_RE = /M(\d{1,3}) (\d{1,3})h(\d{1,3})v1h-(\d{1,3})z/g;

const URI = otpauthUri({
  issuer: PRODUCT_NAME,
  account: 'ann+mfa@example.com',
  secret: Buffer.from('000102030405060708090a0b0c0d0e0f10111213', 'hex'),
});

/** Reads the path back into a size x size matrix of dark modules, checking each run. */
function matrixFromPath(size: number, path: string): boolean[][] {
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  for (const m of path.matchAll(RUN_RE)) {
    const [x, y, n, back] = [m[1], m[2], m[3], m[4]].map(Number) as [
      number,
      number,
      number,
      number,
    ];
    expect(back).toBe(n);
    expect(n).toBeGreaterThan(0);
    expect(x + n).toBeLessThanOrEqual(size);
    expect(y).toBeLessThan(size);
    const row = grid[y] ?? [];
    for (let i = x; i < x + n; i++) {
      expect(row[i], `module ${String(i)},${String(y)} drawn twice`).toBe(false);
      row[i] = true;
    }
  }
  return grid;
}

/** Renders the matrix as RGBA with a 4-module quiet zone, `scale` pixels per module. */
function rasterize(grid: boolean[][], scale: number) {
  const quiet = 4;
  const side = (grid.length + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  grid.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (x + quiet) * scale + dx;
          const py = (y + quiet) * scale + dy;
          const at = (py * side + px) * 4;
          pixels[at] = 0;
          pixels[at + 1] = 0;
          pixels[at + 2] = 0;
        }
      }
    });
  });
  return { pixels, side };
}

/** The 7x7 finder pattern: a dark ring, a light ring, a dark 3x3 core. */
function isFinder(grid: boolean[][], left: number, top: number): boolean {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = Math.min(x, y, 6 - x, 6 - y);
      const want = ring !== 1;
      if (grid[top + y]?.[left + x] !== want) return false;
    }
  }
  return true;
}

describe('QR path decodes to the input', () => {
  it('reads back exactly the otpauth URI, with finders at three corners and size 17 + 4v', () => {
    const { size, path } = qrPath(URI);
    const grid = matrixFromPath(size, path);
    const { pixels, side } = rasterize(grid, 4);
    const decoded = jsQR(pixels, side, side, { inversionAttempts: 'dontInvert' });
    expect(decoded?.data).toBe(URI);
    const version = decoded?.version ?? 0;
    expect(version).toBeGreaterThanOrEqual(1);
    expect(size).toBe(17 + 4 * version);
    expect(isFinder(grid, 0, 0)).toBe(true);
    expect(isFinder(grid, size - 7, 0)).toBe(true);
    expect(isFinder(grid, 0, size - 7)).toBe(true);
    expect(isFinder(grid, size - 7, size - 7)).toBe(false);
  });

  it('decodes short and long inputs too', () => {
    for (const text of ['a', 'otpauth://totp/x', URI.repeat(4)]) {
      const { size, path } = qrPath(text);
      expect(size).toBeGreaterThanOrEqual(21);
      expect(size).toBeLessThanOrEqual(177);
      const { pixels, side } = rasterize(matrixFromPath(size, path), 3);
      expect(jsQR(pixels, side, side)?.data).toBe(text);
    }
  });

  it('uses error correction M with no quiet zone', () => {
    const { size } = qrPath(URI);
    expect(size).toBe(encode(URI, { ecc: 'M', border: 0 }).size);
  });
});

describe('path is safe and complete', () => {
  it('matches the contract regex and draws exactly the dark modules', () => {
    const { size, path } = qrPath(URI);
    expect(Number.isInteger(size)).toBe(true);
    expect(path).toMatch(PATH_RE);
    expect(path.length).toBeGreaterThan(0);
    const matrix = encode(URI, { ecc: 'M', border: 0 }).data;
    const darkCount = matrix.flat().filter(Boolean).length;
    const grid = matrixFromPath(size, path);
    expect(grid.flat().filter(Boolean).length).toBe(darkCount);
    expect(grid).toEqual(matrix);
  });

  it('gives one run per stretch of dark modules, never two touching runs', () => {
    const { path } = qrPath(URI);
    const runs = [...path.matchAll(RUN_RE)].map((m) => m.slice(1, 4).map(Number));
    expect(runs.length).toBeGreaterThan(21);
    for (let i = 1; i < runs.length; i++) {
      const [px, py, pn] = runs[i - 1] ?? [];
      const [x, y] = runs[i] ?? [];
      if (py === y) expect(x).toBeGreaterThan((px ?? 0) + (pn ?? 0));
    }
  });

  it('throws for input too long for any QR version', () => {
    expect(() => qrPath('x'.repeat(5000))).toThrow();
  });
});
