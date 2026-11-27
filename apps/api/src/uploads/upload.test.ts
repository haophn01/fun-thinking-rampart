import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FILE_NAME_HEADER,
  UPLOAD_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  fileRefusedMessage,
} from '../contract';
import { createHarness, type Harness } from '../testing/harness';
import { fakeExe, samplePdf } from './testing/samples';
import { readUpload, registerUploadBodyParser, sendFile } from './upload';

const MIB_25 = 26_214_400;
const POLITICA = 'Política 1.pdf';
/** A real PDF, so the content check passes; downloads send it back byte for byte. */
const FILE_BYTES = Buffer.from(samplePdf());
const TEXT = Buffer.from('plain notes\n');

let harness: Harness;

/**
 * Mounts test routes the way A5 and A6 mount theirs: each child plugin registers the parser for
 * itself. `/test/elsewhere` sits outside both, so it shows the parser doesn't leak.
 */
beforeEach(() => {
  harness = createHarness();
  const { app } = harness;
  void app.register(async (scope) => {
    registerUploadBodyParser(scope);
    scope.post('/test/upload', (request) => {
      const { fileName, bytes } = readUpload(request);
      return {
        fileName,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    scope.get('/api/test/file', (_request, reply) => sendFile(reply, FILE_BYTES, POLITICA));
    scope.get('/test/ascii', (_request, reply) =>
      sendFile(reply, FILE_BYTES, `it's "q" (1)*%.pdf`),
    );
    await Promise.resolve();
  });
  void app.register(async (scope) => {
    registerUploadBodyParser(scope);
    scope.post('/test/second', (request) => ({ size: readUpload(request).bytes.length }));
    await Promise.resolve();
  });
  app.post('/test/elsewhere', () => ({ ok: true }));
});

afterEach(async () => {
  await harness.close();
});

function upload(
  bytes: Buffer | string,
  fileName: string | null,
  contentType = 'application/octet-stream',
  url = '/test/upload',
) {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (fileName !== null) headers[FILE_NAME_HEADER] = fileName;
  return harness.app.inject({ method: 'POST', url, headers, payload: bytes });
}

function errorOf(response: { json: () => unknown }) {
  return (response.json() as { error: { code: string; message: string; details?: unknown } }).error;
}

describe('readUpload', () => {
  it('accepts a Buffer with a good name', async () => {
    const response = await upload(FILE_BYTES, encodeURIComponent(POLITICA));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      fileName: POLITICA,
      size: FILE_BYTES.length,
      sha256: createHash('sha256').update(FILE_BYTES).digest('hex'),
    });

    // The name is trimmed; a content type with parameters still parses; a second scope works.
    const spaced = await upload(FILE_BYTES, encodeURIComponent('  REPORT.PDF '));
    expect(spaced.json()).toMatchObject({ fileName: 'REPORT.PDF' });
    const withParams = await upload(TEXT, 'a.txt', 'application/octet-stream; foo=bar');
    expect(withParams.statusCode).toBe(200);
    const second = await upload(TEXT, 'a.txt', 'application/octet-stream', '/test/second');
    expect(second.json()).toEqual({ size: TEXT.length });
  });

  it('gives 415 unsupported_media_type for a JSON body', async () => {
    const response = await upload(JSON.stringify({ a: 1 }), 'a.pdf', 'application/json');
    expect(response.statusCode).toBe(415);
    expect(errorOf(response)).toMatchObject({
      code: 'unsupported_media_type',
      message: 'The request body must be application/octet-stream',
    });
  });

  it('gives 400 for a missing or malformed header, or a bad name', async () => {
    const bad = [
      null,
      '',
      '%20%20',
      '%E0%A4%A',
      '100%.pdf',
      encodeURIComponent('a/b.pdf'),
      encodeURIComponent('a\\b.pdf'),
      encodeURIComponent('..'),
      encodeURIComponent('bell\u0007.pdf'),
      encodeURIComponent(`${'x'.repeat(252)}.pdf`),
      // Valid as sent, but nothing is left once the invisible characters are removed.
      encodeURIComponent('\u200b\u200d'),
      encodeURIComponent('\u202e\ufeff'),
    ];
    for (const name of bad) {
      const response = await upload(FILE_BYTES, name);
      expect(response.statusCode, JSON.stringify(name)).toBe(400);
      const error = errorOf(response);
      expect(error.code).toBe('validation_failed');
      expect(error.details).toEqual([expect.objectContaining({ path: ['x-file-name'] })]);
    }
  });

  it('stores the sanitized name', async () => {
    const cases: [sent: string, stored: string][] = [
      ['a\u202efdp.txt', 'afdp.txt'],
      ['zero\u200bwidth.txt', 'zerowidth.txt'],
      ['CON.txt', '_CON.txt'],
      ['com1.txt', '_com1.txt'],
      ['a:b?.txt', 'a_b_.txt'],
      ['cafe\u0301.txt', 'café.txt'],
    ];
    for (const [sent, stored] of cases) {
      const response = await upload(TEXT, encodeURIComponent(sent));
      expect(response.statusCode, sent).toBe(200);
      expect(response.json(), sent).toMatchObject({ fileName: stored });
    }
  });

  it('gives 415 unsupported_file_type with the allowed list for .exe', async () => {
    for (const name of [
      'setup.exe',
      'a.pdf.exe',
      'README',
      '.pdf',
      'notes.md',
      'bundle.zip',
      'map.svg',
      'page.html',
      // The override makes it read "report.exe.pdf"; sanitized, it is what it is.
      encodeURIComponent('report\u202efdp.exe'),
    ]) {
      const response = await upload(FILE_BYTES, name);
      expect(response.statusCode, name).toBe(415);
      const error = errorOf(response);
      expect(error.code).toBe('unsupported_file_type');
      expect(error.details).toEqual({ allowed: [...UPLOAD_EXTENSIONS] });
    }
  });

  it('gives 400 for 0 bytes, after the name and type checks', async () => {
    const empty = await upload(Buffer.alloc(0), 'a.pdf');
    expect(empty.statusCode).toBe(400);
    expect(errorOf(empty).code).toBe('validation_failed');
    // A bad type outranks an empty file, as in uploadProblem.
    expect((await upload(Buffer.alloc(0), 'a.exe')).statusCode).toBe(415);
    // A bad name outranks a bad type and an empty file.
    expect((await upload(Buffer.alloc(0), encodeURIComponent('a/b.exe'))).statusCode).toBe(400);
  });

  it('accepts exactly 25 MiB and gives 413 for 25 MiB + 1', async () => {
    expect(UPLOAD_MAX_BYTES).toBe(MIB_25);
    const max = await upload(Buffer.alloc(MIB_25, 0x61), 'big.txt');
    expect(max.statusCode).toBe(200);
    expect(max.json()).toMatchObject({ size: MIB_25 });

    // The size is checked before the content: these bytes aren't a PDF either.
    const over = await upload(Buffer.alloc(MIB_25 + 1, 7), 'big.pdf');
    expect(over.statusCode).toBe(413);
    expect(errorOf(over).code).toBe('payload_too_large');
  });

  it('gives 415 file_refused, last, when the bytes are not what the extension says', async () => {
    const exe = await upload(Buffer.from(fakeExe()), 'report.pdf');
    expect(exe.statusCode).toBe(415);
    expect(errorOf(exe)).toEqual({
      code: 'file_refused',
      message: "This file's contents aren't a real PDF file. It looks like a program.",
      requestId: expect.any(String) as unknown,
      details: { reason: 'content_mismatch', extension: '.pdf', detected: 'executable' },
    });

    // Only content_mismatch names what the bytes look like; the extension is lowercased.
    const markup = await upload(Buffer.from('  <!DOCTYPE html><p>hi</p>'), 'Page.TXT');
    expect(markup.statusCode).toBe(415);
    expect(errorOf(markup)).toMatchObject({
      code: 'file_refused',
      message: fileRefusedMessage('markup_in_text', '.txt'),
      details: { reason: 'markup_in_text', extension: '.txt' },
    });
    expect(errorOf(markup).details).not.toHaveProperty('detected');

    // Unknown bytes give the short message.
    const unknown = await upload(Buffer.from([0xde, 0xad, 0xbe, 0xef]), 'x.png');
    expect(errorOf(unknown)).toMatchObject({
      code: 'file_refused',
      message: "This file's contents aren't a real PNG file.",
      details: { reason: 'content_mismatch', extension: '.png', detected: 'unknown' },
    });

    // 25 MiB of control bytes is judged by content once the size passes.
    const bell = await upload(Buffer.alloc(MIB_25, 7), 'bell.txt');
    expect(bell.statusCode).toBe(415);
    expect(errorOf(bell).details).toEqual({ reason: 'not_text', extension: '.txt' });
  });

  it('only the scopes that register the parser read octet-stream', async () => {
    const response = await upload(
      FILE_BYTES,
      'a.pdf',
      'application/octet-stream',
      '/test/elsewhere',
    );
    expect(response.statusCode).toBe(415);
    // JSON-only routes keep the 1 MiB JSON limit and still refuse other types.
    expect(errorOf(response).code).toBe('unsupported_media_type');
  });
});

describe('sendFile headers', () => {
  it('sends an attachment with an RFC 5987 name, octet-stream, content-length and no-store', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/test/file' });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(FILE_BYTES)).toBe(true);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="Politica 1.pdf"; filename*=UTF-8''Pol%C3%ADtica%201.pdf`,
    );
    expect(response.headers['content-length']).toBe(String(FILE_BYTES.length));
    expect(response.headers['cache-control']).toBe('no-store');
    // Helmet still applies.
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('keeps the ASCII fallback a safe quoted string and percent-encodes RFC 5987 specials', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/test/ascii' });
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="it's _q_ (1)*_.pdf"; filename*=UTF-8''it%27s%20%22q%22%20%281%29%2A%25.pdf`,
    );
  });
});
