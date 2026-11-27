// The name an upload is stored under, made safe to show and to save on any OS. Pure: the upload
// route calls it before the extension check, so a spoofed name is judged as it will be stored.
import { fileNameSchema } from '../contract/files';

// Zero-width characters, the bidi embeddings and overrides (RTLO among them), the invisible
// operators, the bidi isolates and the BOM.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const WINDOWS_RESERVED = /[<>:"|?*]/g;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * The name with invisible and bidi characters removed, Windows-reserved punctuation as `_`, and a
 * `_` before a Windows device name, or null when the result isn't a valid file name. A name with
 * a right-to-left override, `report<U+202E>fdp.exe`, becomes `reportfdp.exe`.
 */
export function sanitizeFileName(name: string): string | null {
  let safe = name.normalize('NFC').replace(INVISIBLE, '').replace(WINDOWS_RESERVED, '_').trim();
  const stem = safe.split('.', 1)[0] ?? '';
  // Windows ignores trailing spaces here too: `CON .pdf` is the console.
  if (DEVICE_NAME.test(stem.trimEnd())) safe = `_${safe}`;
  const parsed = fileNameSchema.safeParse(safe);
  return parsed.success ? parsed.data : null;
}
