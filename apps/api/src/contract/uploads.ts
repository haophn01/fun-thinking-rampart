// What an upload's content check may refuse, and the words the api says when it does. The checker
// itself (`uploads/file-check.ts`) is server code; only these names and messages are shared.
import { z } from 'zod';

/** The zip guard's limits for .docx and .xlsx. Each limit itself passes; one more is refused. */
export const ZIP_LIMITS = {
  maxEntries: 1000,
  maxExpandedBytes: 104_857_600,
  maxRatio: 100,
  /** The largest part the checker reads as text (`[Content_Types].xml`). */
  maxInflatedPartBytes: 1_048_576,
} as const;

/** Why an upload's bytes were refused (the `file_refused` error's `details.reason`). */
export const FILE_REFUSED_REASONS = [
  'content_mismatch',
  'not_text',
  'markup_in_text',
  'macro_enabled',
  'encrypted',
  'zip_too_many_entries',
  'zip_too_large',
  'zip_ratio',
  'zip_malformed',
  'zip_unsafe_path',
] as const;
export type FileRefusedReason = (typeof FILE_REFUSED_REASONS)[number];

/** What an upload's bytes look like, judged by the bytes alone. */
export const DETECTED_FILE_TYPES = [
  'pdf',
  'png',
  'jpeg',
  'docx',
  'xlsx',
  'text',
  'markup',
  'executable',
  'archive',
  'unknown',
] as const;
export type DetectedFileType = (typeof DETECTED_FILE_TYPES)[number];

/** The `file_refused` error's `details`. */
export const fileRefusedDetailsSchema = z.object({
  reason: z.enum(FILE_REFUSED_REASONS),
  extension: z.string(),
  detected: z.enum(DETECTED_FILE_TYPES).optional(),
});
export type FileRefusedDetails = z.infer<typeof fileRefusedDetailsSchema>;

const LOOKS_LIKE: Record<Exclude<DetectedFileType, 'unknown'>, string> = {
  pdf: 'a PDF',
  png: 'a PNG image',
  jpeg: 'a JPEG image',
  docx: 'a Word document',
  xlsx: 'an Excel workbook',
  text: 'a text file',
  markup: 'a web page or SVG',
  executable: 'a program',
  archive: 'an archive',
};

const MESSAGES: Record<Exclude<FileRefusedReason, 'content_mismatch'>, string> = {
  not_text: "This file isn't plain text. Save it as UTF-8 text and try again.",
  markup_in_text: "This text file holds web markup (HTML, SVG or XML), which can't be uploaded.",
  macro_enabled: "Files with macros can't be uploaded. Save it as .docx or .xlsx without macros.",
  encrypted: "Password-protected files can't be uploaded.",
  zip_too_many_entries: 'This file holds more than 1,000 parts.',
  zip_too_large: 'This file expands to more than 100 MiB.',
  zip_ratio: 'This file expands to more than 100 times its size.',
  zip_malformed: 'This file is damaged or uses an unsupported format.',
  zip_unsafe_path: 'This file holds a part with an unsafe name.',
};

/**
 * The `file_refused` message. `extension` may have its dot (`.pdf`) or not; it is shown uppercased
 * without it. Only `content_mismatch` says what the file looks like, and only when that is known.
 */
export function fileRefusedMessage(
  reason: FileRefusedReason,
  extension: string,
  detected?: DetectedFileType,
): string {
  if (reason !== 'content_mismatch') return MESSAGES[reason];
  const ext = extension.replace(/^\./, '').toUpperCase();
  const base = `This file's contents aren't a real ${ext} file.`;
  if (detected === undefined || detected === 'unknown') return base;
  return `${base} It looks like ${LOOKS_LIKE[detected]}.`;
}
