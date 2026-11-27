import { describe, expect, it } from 'vitest';
import {
  DETECTED_FILE_TYPES,
  FILE_REFUSED_REASONS,
  ZIP_LIMITS,
  fileRefusedDetailsSchema,
  fileRefusedMessage,
  type DetectedFileType,
} from './uploads';

describe('uploads contract', () => {
  it('fileRefusedMessage texts', () => {
    expect(fileRefusedMessage('content_mismatch', '.pdf')).toBe(
      "This file's contents aren't a real PDF file.",
    );
    expect(fileRefusedMessage('content_mismatch', 'docx', 'unknown')).toBe(
      "This file's contents aren't a real DOCX file.",
    );

    const looksLike: Record<Exclude<DetectedFileType, 'unknown'>, string> = {
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
    for (const [detected, words] of Object.entries(looksLike)) {
      expect(fileRefusedMessage('content_mismatch', '.Jpg', detected as DetectedFileType)).toBe(
        `This file's contents aren't a real JPG file. It looks like ${words}.`,
      );
    }

    const others = {
      not_text: "This file isn't plain text. Save it as UTF-8 text and try again.",
      markup_in_text:
        "This text file holds web markup (HTML, SVG or XML), which can't be uploaded.",
      macro_enabled:
        "Files with macros can't be uploaded. Save it as .docx or .xlsx without macros.",
      encrypted: "Password-protected files can't be uploaded.",
      zip_too_many_entries: 'This file holds more than 1,000 parts.',
      zip_too_large: 'This file expands to more than 100 MiB.',
      zip_ratio: 'This file expands to more than 100 times its size.',
      zip_malformed: 'This file is damaged or uses an unsupported format.',
      zip_unsafe_path: 'This file holds a part with an unsafe name.',
    } as const;
    for (const [reason, message] of Object.entries(others)) {
      const key = reason as keyof typeof others;
      expect(fileRefusedMessage(key, '.txt')).toBe(message);
      // The detected sentence belongs to content_mismatch alone.
      expect(fileRefusedMessage(key, '.docx', 'executable')).toBe(message);
    }
    expect([...Object.keys(others), 'content_mismatch'].sort()).toEqual(
      [...FILE_REFUSED_REASONS].sort(),
    );
  });

  it('pins the limits, reasons, detected types and details shape', () => {
    expect(ZIP_LIMITS).toEqual({
      maxEntries: 1000,
      maxExpandedBytes: 104_857_600,
      maxRatio: 100,
      maxInflatedPartBytes: 1_048_576,
    });
    expect(FILE_REFUSED_REASONS).toEqual([
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
    ]);
    expect(DETECTED_FILE_TYPES).toEqual([
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
    ]);
    expect(
      fileRefusedDetailsSchema.parse({
        reason: 'content_mismatch',
        extension: '.pdf',
        detected: 'executable',
      }),
    ).toEqual({ reason: 'content_mismatch', extension: '.pdf', detected: 'executable' });
    expect(fileRefusedDetailsSchema.parse({ reason: 'zip_ratio', extension: '.docx' })).toEqual({
      reason: 'zip_ratio',
      extension: '.docx',
    });
    expect(fileRefusedDetailsSchema.safeParse({ reason: 'virus', extension: '.pdf' }).success).toBe(
      false,
    );
    expect(
      fileRefusedDetailsSchema.safeParse({
        reason: 'zip_ratio',
        extension: '.pdf',
        detected: 'gif',
      }).success,
    ).toBe(false);
  });
});
