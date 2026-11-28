// The server half of the upload protocol in `contract/files.ts`: an upload is a raw
// `application/octet-stream` body with its name in the `x-file-name` header.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FILE_NAME_HEADER,
  UPLOAD_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  fileNameSchema,
  fileRefusedMessage,
  isAllowedFileType,
  lastExtension,
  type FileRefusedDetails,
} from '../contract';
import { AppError } from '../errors';
import { checkFileContent } from './file-check';
import { sanitizeFileName } from './file-name';

export interface Upload {
  /** The decoded name as `sanitizeFileName` leaves it: what is stored, returned and audited. */
  fileName: string;
  bytes: Buffer;
}

/**
 * Lets the routes in `scope` read `application/octet-stream` bodies of up to `UPLOAD_MAX_BYTES`
 * as a Buffer; one byte more is 413 `payload_too_large`. Call it once per child plugin (calling it
 * twice in one scope throws), so the parser never reaches the JSON-only routes elsewhere.
 */
export function registerUploadBodyParser(scope: FastifyInstance): void {
  scope.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: UPLOAD_MAX_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );
}

function badName(message: string): AppError {
  return new AppError('validation_failed', message, {
    details: [{ path: [FILE_NAME_HEADER], message }],
  });
}

function decodeHeader(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') {
    throw badName(`The ${FILE_NAME_HEADER} header must carry the URI-encoded file name`);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw badName(`The ${FILE_NAME_HEADER} header is not a valid URI-encoded name`);
  }
}

/** The sanitized name, or 400 naming why the name (as sent, or once sanitized) isn't one. */
function safeName(sent: string): string {
  const fileName = sanitizeFileName(sent);
  if (fileName !== null) return fileName;
  const asSent = fileNameSchema.safeParse(sent);
  throw badName(
    asSent.success
      ? 'The file name is empty once invisible characters are removed'
      : (asSent.error.issues[0]?.message ?? 'Not a valid file name'),
  );
}

/** 415 `file_refused` when the bytes aren't a real file of the name's extension. */
function assertContent(fileName: string, bytes: Uint8Array): void {
  // The extension check has passed, so there is one.
  const extension = lastExtension(fileName) ?? '';
  const refusal = checkFileContent(extension, bytes);
  if (refusal === null) return;
  const details: FileRefusedDetails = {
    reason: refusal.reason,
    extension,
    ...(refusal.detected === undefined ? {} : { detected: refusal.detected }),
  };
  throw new AppError(
    'file_refused',
    fileRefusedMessage(refusal.reason, extension, refusal.detected),
    { details },
  );
}

/**
 * Reads an upload's name and bytes, checking them in the contract's order: an octet-stream body
 * (415 `unsupported_media_type`), the name header (400), the sanitized name (400), the file type
 * (415 `unsupported_file_type` with `details.allowed`), an empty file (400), the size (413), then
 * the content (415 `file_refused`). Nothing is stored before it returns.
 */
export function readUpload(request: FastifyRequest): Upload {
  const { body } = request;
  if (!Buffer.isBuffer(body)) {
    throw new AppError(
      'unsupported_media_type',
      'The request body must be application/octet-stream',
    );
  }

  const fileName = safeName(decodeHeader(request.headers[FILE_NAME_HEADER]));

  if (!isAllowedFileType(fileName)) {
    throw new AppError('unsupported_file_type', "This file type can't be uploaded", {
      details: { allowed: [...UPLOAD_EXTENSIONS] },
    });
  }
  if (body.length === 0) {
    throw new AppError('validation_failed', 'The file is empty', {
      details: [{ path: ['body'], message: 'The file is empty' }],
    });
  }
  // The parser's limit already refuses this; kept so a scope with another parser can't skip it.
  if (body.length > UPLOAD_MAX_BYTES) {
    throw new AppError('payload_too_large', 'The file is larger than 25 MiB');
  }
  assertContent(fileName, body);
  return { fileName, bytes: body };
}

/**
 * A plain-ASCII stand-in for `filename="…"`: accents are dropped, and anything outside printable
 * ASCII, plus `"`, `\` and `%`, becomes `_`.
 */
function asciiFallback(fileName: string): string {
  return fileName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]|["\\%]/g, '_');
}

/** RFC 5987 `ext-value` characters: `encodeURIComponent` plus the four it leaves alone. */
function rfc5987(fileName: string): string {
  return encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The `content-disposition` value that downloads `fileName` under its own name. */
export function attachmentDisposition(fileName: string): string {
  return `attachment; filename="${asciiFallback(fileName)}"; filename*=UTF-8''${rfc5987(fileName)}`;
}

/**
 * Answers 200 with the file's bytes as a download that is never cached. Helmet's `nosniff` and
 * CSP headers still apply.
 */
export function sendFile(reply: FastifyReply, bytes: Uint8Array, fileName: string): FastifyReply {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return reply
    .code(200)
    .header('content-type', 'application/octet-stream')
    .header('content-disposition', attachmentDisposition(fileName))
    .header('content-length', String(buffer.length))
    .header('cache-control', 'no-store')
    .send(buffer);
}
