// The server half of the upload protocol in `contract/files.ts`: an upload is a raw
// `application/octet-stream` body with its name in the `x-file-name` header.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FILE_NAME_HEADER,
  UPLOAD_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  fileNameSchema,
  isAllowedFileType,
} from '../contract';
import { AppError } from '../errors';

export interface Upload {
  /** The decoded, trimmed file name. */
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

/**
 * Reads an upload's name and bytes, checking them in the contract's order: an octet-stream body
 * (415 `unsupported_media_type`), the name header (400), the file type (415
 * `unsupported_file_type` with `details.allowed`), then an empty file (400).
 */
export function readUpload(request: FastifyRequest): Upload {
  const { body } = request;
  if (!Buffer.isBuffer(body)) {
    throw new AppError(
      'unsupported_media_type',
      'The request body must be application/octet-stream',
    );
  }

  const name = fileNameSchema.safeParse(decodeHeader(request.headers[FILE_NAME_HEADER]));
  if (!name.success) throw badName(name.error.issues[0]?.message ?? 'Not a valid file name');
  const fileName = name.data;

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
