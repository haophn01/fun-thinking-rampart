import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  PRODUCT_NAME,
  errorEnvelopeSchema,
  healthResponseSchema,
  type ErrorCode,
} from './index';

const contractDir = import.meta.dirname;

/** Every module specifier a file imports or re-exports, static or dynamic. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bimport\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bexport\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
  );
}

describe('api contract', () => {
  it('contract is browser-safe', () => {
    const files = readdirSync(contractDir).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(files).toEqual(expect.arrayContaining(['index.ts', 'health.ts', 'error.ts']));

    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(join(contractDir, file), 'utf8'));
      for (const specifier of specifiers) {
        expect(
          specifier === 'zod' || specifier.startsWith('./'),
          `${file} imports "${specifier}"`,
        ).toBe(true);
      }
    }

    expect(PRODUCT_NAME).toBe('Rampart');
  });

  it('the scanner sees every import form', () => {
    const sample = [
      "import { z } from 'zod';",
      "import type { X } from 'node:fs';",
      "export * from './health';",
      "import 'side-effect';",
      "const m = await import('fastify');",
    ].join('\n');
    expect(importSpecifiers(sample)).toEqual(
      expect.arrayContaining(['zod', 'node:fs', './health', 'side-effect', 'fastify']),
    );
  });

  it('health and error schemas match the contract', () => {
    expect(healthResponseSchema.parse({ status: 'ok', db: 'ok' })).toEqual({
      status: 'ok',
      db: 'ok',
    });
    expect(healthResponseSchema.safeParse({ status: 'ok' }).success).toBe(false);

    const codes: readonly ErrorCode[] = ERROR_CODES;
    expect(codes).toEqual([
      'not_found',
      'validation_failed',
      'payload_too_large',
      'db_unavailable',
      'internal_error',
      'unauthenticated',
      'invalid_credentials',
      'forbidden',
      'csrf_failed',
      'setup_complete',
      'email_taken',
      'last_admin',
      'unsupported_media_type',
      'too_many_attempts',
      'poam_ineligible',
      'poam_item_exists',
      'poam_item_closed',
      'closeout_not_ready',
      'cui_file_refused',
      'evidence_not_cui',
      'unsupported_file_type',
      'file_integrity_failed',
    ]);

    const envelope = { error: { code: 'not_found', message: 'No route', requestId: 'abc' } };
    expect(errorEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: 'not_found', message: 'x' } }).success,
    ).toBe(false);
  });
});
