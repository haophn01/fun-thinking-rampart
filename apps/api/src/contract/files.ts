// The upload protocol shared by the api and the web app. An upload is a raw
// `application/octet-stream` body; the file's name travels in `FILE_NAME_HEADER`.
import { z } from 'zod';
import { userRefSchema } from './common';

/** Carries the uploaded file's name as `encodeURIComponent(fileName)`. */
export const FILE_NAME_HEADER = 'x-file-name';

/** 25 MiB. A body of exactly this size is accepted; one byte more is 413 `payload_too_large`. */
export const UPLOAD_MAX_BYTES = 26_214_400;

/** The only file types an upload may have, matched case-insensitively on the last extension. */
export const UPLOAD_EXTENSIONS = [
  '.csv',
  '.doc',
  '.docx',
  '.gif',
  '.jpeg',
  '.jpg',
  '.json',
  '.log',
  '.md',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.txt',
  '.xls',
  '.xlsx',
  '.xml',
  '.zip',
] as const;
export type UploadExtension = (typeof UPLOAD_EXTENSIONS)[number];

/** The `file_integrity_failed` message. It never names a path. */
export const FILE_INTEGRITY_MESSAGE =
  "The stored file is missing or doesn't match its recorded SHA-256.";

// U+0000–U+001F and U+007F.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** A file name as stored: trimmed, 1–255 characters, no path separators or control characters. */
export const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !name.includes('/') && !name.includes('\\'), {
    message: 'A file name may not contain / or \\',
  })
  .refine((name) => !CONTROL_CHARACTER.test(name), {
    message: 'A file name may not contain control characters',
  })
  .refine((name) => name !== '.' && name !== '..', { message: 'Not a file name' });

/** A SHA-256 digest as lowercase hex. */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** One stored file version of an evidence item or policy, as the api shows it. Never the bytes. */
export const fileVersionSchema = z.object({
  version: z.number().int().min(1),
  fileName: z.string(),
  size: z.number().int().min(1),
  sha256: sha256Schema,
  createdAt: z.iso.datetime(),
  createdBy: userRefSchema,
});
export type FileVersion = z.infer<typeof fileVersionSchema>;

/**
 * The name's last extension, lowercased, or null when it has none. A name that only starts with a
 * dot (`.pdf`) has no extension, as with `path.extname`.
 */
function lastExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return null;
  return fileName.slice(dot).toLowerCase();
}

/** Whether a (trimmed) file name ends in one of `UPLOAD_EXTENSIONS`. */
export function isAllowedFileType(fileName: string): boolean {
  const extension = lastExtension(fileName);
  return extension !== null && (UPLOAD_EXTENSIONS as readonly string[]).includes(extension);
}

export type UploadProblem = 'invalid_file_name' | 'unsupported_file_type' | 'empty' | 'too_large';

/**
 * What's wrong with an upload before it is sent, checked in this order: the name, its type, an
 * empty file, then the size. `null` means it may be sent. The web runs it before sending; the api
 * runs the same checks.
 */
export function uploadProblem(fileName: string, size: number): UploadProblem | null {
  const name = fileNameSchema.safeParse(fileName);
  if (!name.success) return 'invalid_file_name';
  if (!isAllowedFileType(name.data)) return 'unsupported_file_type';
  if (size <= 0) return 'empty';
  if (size > UPLOAD_MAX_BYTES) return 'too_large';
  return null;
}
