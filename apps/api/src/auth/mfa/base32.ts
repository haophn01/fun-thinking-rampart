// RFC 4648 base32, for TOTP secrets. Encoding is uppercase with no padding; decoding takes either
// case and throws on anything else: padding, spaces, characters outside the alphabet, a length no
// whole number of bytes gives, or leftover bits that aren't zero. Strict, so one secret has one
// spelling.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Characters left over after the last full 8-character group that whole bytes can give. */
const VALID_TAIL_LENGTHS = new Set([0, 2, 4, 5, 7]);

export class Base32Error extends Error {
  override name = 'Base32Error';
}

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((buffer >> bits) & 31);
    }
  }
  if (bits > 0) out += ALPHABET.charAt((buffer << (5 - bits)) & 31);
  return out;
}

export function base32Decode(text: string): Buffer {
  if (!VALID_TAIL_LENGTHS.has(text.length % 8)) {
    throw new Base32Error('base32 text has an impossible length');
  }
  const upper = text.toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of upper) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Base32Error('base32 text has a character outside the alphabet');
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) {
    throw new Base32Error('base32 text has leftover bits that are not zero');
  }
  return Buffer.from(out);
}
