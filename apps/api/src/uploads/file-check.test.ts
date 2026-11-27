import { describe, expect, it } from 'vitest';
import { ZIP_LIMITS } from '../contract/uploads';
import { renderSspDocx } from '../../ssp/render';
import { checkFileContent, detectFileType } from './file-check';
import {
  docxEntries,
  fakeExe,
  sampleDocx,
  sampleJpeg,
  samplePdf,
  samplePng,
  sampleXlsx,
  xlsxEntries,
  zipBombDocx,
  zipOf,
  type ZipEntryInput,
} from './testing/samples';

const text = (value: string) => new TextEncoder().encode(value);
const bytesOf = (...values: number[]) => new Uint8Array(values);
const withBom = (value: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...text(value)]);

/** The office entries with `[Content_Types].xml` replaced by `edit` of it. */
function withContentTypes(
  entries: ZipEntryInput[],
  edit: (xml: string) => string,
): ZipEntryInput[] {
  return entries.map((entry) =>
    entry.name === '[Content_Types].xml' && typeof entry.data === 'string'
      ? { ...entry, data: edit(entry.data) }
      : entry,
  );
}

describe('checkFileContent', () => {
  it('accepts real PDF, PNG, JPEG, DOCX, XLSX, TXT and CSV', async () => {
    const ssp = await renderSspDocx(
      { blocks: [{ kind: 'title', text: 'System Security Plan' }] },
      { generatedAt: new Date('2026-11-27T12:00:00Z') },
    );
    const accepted: [string, Uint8Array][] = [
      ['.pdf', samplePdf()],
      ['.PDF', samplePdf()],
      ['.png', samplePng()],
      ['.jpg', sampleJpeg()],
      ['.jpeg', sampleJpeg()],
      ['.docx', sampleDocx()],
      ['.docx', ssp],
      ['.xlsx', sampleXlsx()],
      ['.txt', text('Firewall reviewed 2026-11-01.\nNo findings.\n')],
      ['.txt', text('caf\u00e9 \u4e2d\u6587 \u{1f512}')],
      ['.csv', withBom('control,status\r\nAC.L2-3.1.1,met\r\n')],
    ];
    for (const [extension, bytes] of accepted) {
      expect(checkFileContent(extension, bytes), extension).toBeNull();
    }
  });

  it("refuses bytes that don't match the extension, naming what they are", () => {
    const refused: [string, Uint8Array, string][] = [
      ['.pdf', fakeExe(), 'executable'],
      ['.jpg', samplePng(), 'png'],
      ['.png', sampleJpeg(), 'jpeg'],
      ['.png', samplePdf(), 'pdf'],
      ['.xlsx', sampleDocx(), 'docx'],
      ['.docx', sampleXlsx(), 'xlsx'],
      ['.docx', zipOf([{ name: 'notes.txt', data: 'hello' }]), 'archive'],
      ['.pdf', text(' %PDF-1.4\n'), 'text'],
      ['.pdf', text('%PDF-'), 'text'],
      ['.pdf', text('%PDF-1'), 'text'],
      ['.pdf', text('%PDF-a.4'), 'text'],
      ['.png', text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'markup'],
      ['.pdf', text('\n  <!doctype html><html></html>'), 'markup'],
      ['.pdf', bytesOf(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0), 'executable'],
      ['.pdf', bytesOf(0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1), 'executable'],
      ['.pdf', bytesOf(0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 7), 'executable'],
      ['.pdf', bytesOf(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2), 'executable'],
      ['.pdf', text('#!/bin/sh\necho hi\n'), 'executable'],
      ['.pdf', bytesOf(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00), 'archive'],
      ['.pdf', bytesOf(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4), 'archive'],
      ['.pdf', bytesOf(0x1f, 0x8b, 8, 0, 0, 0, 0, 0), 'archive'],
      ['.pdf', bytesOf(0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26), 'archive'],
      ['.pdf', bytesOf(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 4), 'archive'],
      ['.pdf', zipOf([{ name: 'a.txt', data: 'x' }]), 'archive'],
      ['.pdf', zipBombDocx(), 'docx'],
      ['.pdf', new Uint8Array([0x01, 0x02, 0x03, 0x80]), 'unknown'],
      // PNG's signature without IHDR after it.
      ['.png', samplePng().subarray(0, 12), 'unknown'],
      ['.jpg', bytesOf(0xff, 0xd8), 'unknown'],
      ['.docx', bytesOf(0x50, 0x4b, 0x03), 'unknown'],
    ];
    for (const [extension, bytes, detected] of refused) {
      expect(checkFileContent(extension, bytes), `${extension} ${detected}`).toEqual({
        reason: 'content_mismatch',
        detected,
      });
    }

    // A tar archive: "ustar" at byte 257.
    const tar = new Uint8Array(512);
    tar.set(text('notes.txt'), 0);
    tar.set(text('ustar'), 257);
    expect(checkFileContent('.pdf', tar)).toEqual({
      reason: 'content_mismatch',
      detected: 'archive',
    });

    // An extension with no content rule is refused, never waved through.
    expect(checkFileContent('.svg', text('<svg/>'))).toEqual({
      reason: 'content_mismatch',
      detected: 'markup',
    });
    expect(checkFileContent('.exe', fakeExe())).toEqual({
      reason: 'content_mismatch',
      detected: 'executable',
    });

    // The zip guard's answer comes through for an office file.
    expect(checkFileContent('.docx', zipBombDocx())).toEqual({ reason: 'zip_ratio' });
    expect(checkFileContent('.xlsx', zipOf(xlsxEntries(), { encrypted: true }))).toEqual({
      reason: 'encrypted',
    });
    expect(
      checkFileContent('.docx', zipOf([...docxEntries(), { name: '../evil.txt', data: 'x' }])),
    ).toEqual({ reason: 'zip_unsafe_path' });
    // A content-types part too big to read is damage, not a pass.
    const hugeTypes = withContentTypes(docxEntries(), (xml) =>
      xml.replace('</Types>', `${' '.repeat(ZIP_LIMITS.maxInflatedPartBytes)}</Types>`),
    ).map((entry) => ({ ...entry, method: 'store' as const }));
    expect(checkFileContent('.docx', zipOf(hugeTypes))).toEqual({ reason: 'zip_malformed' });
  });

  it('text check edges', () => {
    for (const extension of ['.txt', '.csv']) {
      const notText = [
        bytesOf(0x61, 0x00, 0x62),
        bytesOf(0x61, 0x07),
        bytesOf(0x1b, 0x5b, 0x33, 0x31, 0x6d),
        bytesOf(0x61, 0x7f),
        bytesOf(0x61, 0x0b),
        bytesOf(0x61, 0x0e),
        bytesOf(0x61, 0x1f),
        bytesOf(0xc3, 0x28),
        bytesOf(0x61, 0xe4, 0xb8),
        bytesOf(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00),
        bytesOf(0xfe, 0xff, 0x00, 0x68),
        withBom('a\u0000'),
        fakeExe(),
        samplePng(),
      ];
      for (const bytes of notText) {
        expect(checkFileContent(extension, bytes), `${extension} ${String([...bytes])}`).toEqual({
          reason: 'not_text',
        });
      }

      const passes = [
        text('a\tb\r\nc\nd\fe\r'),
        text('replacement \ufffd kept'),
        text('a<b and c > d'),
        text('x <svg> later in the text'),
        text('   '),
        withBom('id,name\n1,Pat\n'),
      ];
      for (const bytes of passes) expect(checkFileContent(extension, bytes)).toBeNull();

      const markup = [
        '  <!DOCTYPE html>\n<html></html>',
        '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        '<?xml version="1.0"?><a/>',
        '<script>alert(1)</script>',
        '<HTML><body></body></HTML>',
        '\r\n\t<Svg/>',
      ];
      for (const value of markup) {
        expect(checkFileContent(extension, text(value)), value).toEqual({
          reason: 'markup_in_text',
        });
      }
      expect(checkFileContent(extension, withBom('<svg/>'))).toEqual({ reason: 'markup_in_text' });
    }
  });

  it('refuses macro-enabled office files', () => {
    const macroFiles = [
      zipOf([...docxEntries(), { name: 'word/vbaProject.bin', data: 'macro' }]),
      zipOf([...xlsxEntries(), { name: 'xl/vbaProject.bin', data: 'macro' }]),
      zipOf([...docxEntries(), { name: 'word/VBAPROJECT.BIN', data: 'macro' }]),
      zipOf(
        withContentTypes(docxEntries(), (xml) =>
          xml.replace(
            'wordprocessingml.document.main+xml',
            'wordprocessingml.document.main+xml"/><Override PartName="/word/x.xml" ' +
              'ContentType="application/vnd.ms-word.document.macroEnabled.main+xml',
          ),
        ),
      ),
      zipOf(
        withContentTypes(xlsxEntries(), (xml) =>
          xml.replace(
            '</Types>',
            '<Default Extension="bin" ContentType="x-MACROENABLED"/></Types>',
          ),
        ),
      ),
    ];
    expect(checkFileContent('.docx', macroFiles[0] ?? new Uint8Array())).toEqual({
      reason: 'macro_enabled',
    });
    expect(checkFileContent('.xlsx', macroFiles[1] ?? new Uint8Array())).toEqual({
      reason: 'macro_enabled',
    });
    expect(checkFileContent('.docx', macroFiles[2] ?? new Uint8Array())).toEqual({
      reason: 'macro_enabled',
    });
    expect(checkFileContent('.docx', macroFiles[3] ?? new Uint8Array())).toEqual({
      reason: 'macro_enabled',
    });
    expect(checkFileContent('.xlsx', macroFiles[4] ?? new Uint8Array())).toEqual({
      reason: 'macro_enabled',
    });
  });
});

describe('detectFileType', () => {
  it('names each sample by its bytes alone', () => {
    expect(detectFileType(samplePdf())).toBe('pdf');
    expect(detectFileType(samplePng())).toBe('png');
    expect(detectFileType(sampleJpeg())).toBe('jpeg');
    expect(detectFileType(sampleDocx())).toBe('docx');
    expect(detectFileType(sampleXlsx())).toBe('xlsx');
    expect(detectFileType(fakeExe())).toBe('executable');
    expect(detectFileType(text('plain words'))).toBe('text');
    expect(detectFileType(text('<p>hi</p>'))).toBe('markup');
    expect(detectFileType(bytesOf(0x50, 0x4b, 0x03, 0x04, 0, 0))).toBe('archive');
  });
});
