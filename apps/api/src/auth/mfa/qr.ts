// The enrollment QR code as one SVG path string, so the web app draws it with no image, no inline
// style and no library of its own. The matrix is uqr's at error correction M with no quiet zone
// (the page adds that); each run of dark modules in a row becomes `M<x> <y>h<n>v1h-<n>z`, which is
// the only shape the contract's path regex allows.
import { encode } from 'uqr';

export interface QrPath {
  /** The matrix side in modules, without a quiet zone: 17 + 4 x version, 21 to 177. */
  size: number;
  path: string;
}

/** Throws when `text` is too long for any QR version. */
export function qrPath(text: string): QrPath {
  const { size, data } = encode(text, { ecc: 'M', border: 0 });
  let path = '';
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x++;
      const n = x - start;
      path += `M${String(start)} ${String(y)}h${String(n)}v1h-${String(n)}z`;
    }
  });
  return { size, path };
}
