import { describe, expect, it } from 'vitest';
import {
  CONDITIONAL_STATUS_LABELS,
  OBJECTIVE_STATUS_LABELS,
  REQUIREMENT_NOT_APPLICABLE_LABEL,
  REQUIREMENT_STATUS_LABELS,
  SSP_CONTENT_TYPE,
  SYSTEM_PROFILE_FIELDS,
  patchSystemProfileRequestSchema,
  sspFileName,
  systemProfileResponseSchema,
  systemProfileSchema,
} from './index';

const TODAY = '2026-11-24';

const accepts = (value: unknown) => patchSystemProfileRequestSchema.safeParse(value).success;
const parse = (value: unknown) => patchSystemProfileRequestSchema.parse(value);

const CAPS = {
  systemName: 200,
  systemIdentifier: 100,
  organizationName: 200,
  description: 20000,
  authorizationBoundary: 20000,
  environment: 20000,
  interconnections: 20000,
  informationTypes: 20000,
  systemOwner: 200,
  securityContact: 200,
} as const;

describe('system profile contract', () => {
  it('field rules', () => {
    // The fields, in the documented order, with their labels.
    expect(SYSTEM_PROFILE_FIELDS).toEqual([
      { key: 'systemName', label: 'System name' },
      { key: 'systemIdentifier', label: 'System identifier' },
      { key: 'organizationName', label: 'Organization' },
      { key: 'cageCode', label: 'CAGE code' },
      { key: 'description', label: 'System description' },
      { key: 'authorizationBoundary', label: 'Authorization boundary' },
      { key: 'environment', label: 'Operating environment' },
      { key: 'interconnections', label: 'Interconnections with other systems' },
      { key: 'informationTypes', label: 'Information types handled' },
      { key: 'systemOwner', label: 'System owner' },
      { key: 'systemOwnerEmail', label: 'System owner email' },
      { key: 'securityContact', label: 'Security contact' },
      { key: 'securityContactEmail', label: 'Security contact email' },
    ]);

    // Text trims; empty or whitespace-only becomes null; null stays null.
    for (const key of Object.keys(CAPS)) {
      expect(parse({ [key]: '  Hello  ' }), key).toEqual({ [key]: 'Hello' });
      expect(parse({ [key]: '' }), key).toEqual({ [key]: null });
      expect(parse({ [key]: ' \t\n ' }), key).toEqual({ [key]: null });
      expect(parse({ [key]: null }), key).toEqual({ [key]: null });
    }

    // Length caps hold after trimming: exactly the cap passes, one more fails.
    for (const [key, cap] of Object.entries(CAPS)) {
      expect(accepts({ [key]: 'x'.repeat(cap) }), `${key} at ${String(cap)}`).toBe(true);
      expect(accepts({ [key]: ` ${'x'.repeat(cap)} ` }), `${key} padded`).toBe(true);
      expect(accepts({ [key]: 'x'.repeat(cap + 1) }), `${key} over`).toBe(false);
    }

    // CAGE code: exactly 5 of [A-Z0-9] after trimming and uppercasing.
    expect(parse({ cageCode: '1abc2' })).toEqual({ cageCode: '1ABC2' });
    expect(parse({ cageCode: '  7x9Y0 ' })).toEqual({ cageCode: '7X9Y0' });
    expect(parse({ cageCode: '   ' })).toEqual({ cageCode: null });
    expect(parse({ cageCode: null })).toEqual({ cageCode: null });
    for (const bad of ['ABCD', 'ABCDEF', 'AB-12', 'AB 12', 'ÄBC12', '1234', '123456']) {
      expect(accepts({ cageCode: bad }), bad).toBe(false);
    }

    // Emails: trimmed and lowercased, checked, blank becomes null.
    for (const key of ['systemOwnerEmail', 'securityContactEmail']) {
      expect(parse({ [key]: ' Owner@Example.COM ' }), key).toEqual({ [key]: 'owner@example.com' });
      expect(parse({ [key]: '  ' }), key).toEqual({ [key]: null });
      expect(parse({ [key]: null }), key).toEqual({ [key]: null });
      for (const bad of ['not-an-email', 'a@', '@b.com', 'a b@c.com']) {
        expect(accepts({ [key]: bad }), `${key} ${bad}`).toBe(false);
      }
    }

    // Wrong types are refused.
    expect(accepts({ systemName: 5 })).toBe(false);
    expect(accepts({ systemName: ['x'] })).toBe(false);

    // Patches are strict, every field is optional, and `{}` is refused.
    expect(accepts({})).toBe(false);
    expect(accepts({ systemName: 'A', extra: 1 })).toBe(false);
    expect(accepts({ updatedAt: '2026-11-24T00:00:00.000Z' })).toBe(false);
    expect(accepts({ updatedBy: null })).toBe(false);
    expect(accepts(null)).toBe(false);
    expect(parse({ systemName: 'A', cageCode: 'abcde' })).toEqual({
      systemName: 'A',
      cageCode: 'ABCDE',
    });
    const everything = Object.fromEntries(SYSTEM_PROFILE_FIELDS.map(({ key }) => [key, null]));
    expect(parse(everything)).toEqual(everything);

    // The response schema is plain: every field plus the save stamp, all nullable.
    const empty = { ...everything, updatedAt: null, updatedBy: null };
    expect(systemProfileSchema.parse(empty)).toEqual(empty);
    const saved = {
      ...everything,
      systemName: '  kept as sent  ',
      updatedAt: '2026-11-24T09:00:00.000Z',
      updatedBy: { id: 'u1', displayName: 'Ada' },
    };
    expect(systemProfileSchema.parse(saved)).toEqual(saved);
    expect(systemProfileResponseSchema.parse({ profile: empty })).toEqual({ profile: empty });
    expect(systemProfileSchema.safeParse({ ...empty, systemName: undefined }).success).toBe(false);
  });

  it('sspFileName edges', () => {
    expect(sspFileName('SYS-01', TODAY)).toBe(`SSP-SYS-01-${TODAY}.docx`);
    expect(sspFileName('a.b_c-D9', TODAY)).toBe(`SSP-a.b_c-D9-${TODAY}.docx`);
    // Each run of other characters becomes one `-`.
    expect(sspFileName('ACME  Prod / East', TODAY)).toBe(`SSP-ACME-Prod-East-${TODAY}.docx`);
    expect(sspFileName('a--b', TODAY)).toBe(`SSP-a--b-${TODAY}.docx`);
    expect(sspFileName('Système № 7', TODAY)).toBe(`SSP-Syst-me-7-${TODAY}.docx`);
    // `-` is trimmed from both ends, including ones the cleaning made.
    expect(sspFileName('--/ID/--', TODAY)).toBe(`SSP-ID-${TODAY}.docx`);
    expect(sspFileName(' ID ', TODAY)).toBe(`SSP-ID-${TODAY}.docx`);
    // Capped at 64 characters.
    expect(sspFileName('x'.repeat(64), TODAY)).toBe(`SSP-${'x'.repeat(64)}-${TODAY}.docx`);
    expect(sspFileName('x'.repeat(65), TODAY)).toBe(`SSP-${'x'.repeat(64)}-${TODAY}.docx`);
    expect(sspFileName(`!!${'y'.repeat(80)}`, TODAY)).toBe(`SSP-${'y'.repeat(64)}-${TODAY}.docx`);
    // A cut that lands on a `-` doesn't leave it hanging.
    expect(sspFileName(`${'z'.repeat(63)} tail`, TODAY)).toBe(
      `SSP-${'z'.repeat(63)}-${TODAY}.docx`,
    );
    // Null, empty, and all-symbol IDs fall back to `system`.
    expect(sspFileName(null, TODAY)).toBe(`SSP-system-${TODAY}.docx`);
    expect(sspFileName('', TODAY)).toBe(`SSP-system-${TODAY}.docx`);
    expect(sspFileName('/// ***', TODAY)).toBe(`SSP-system-${TODAY}.docx`);
    expect(sspFileName('---', TODAY)).toBe(`SSP-system-${TODAY}.docx`);
    expect(sspFileName('日本語', TODAY)).toBe(`SSP-system-${TODAY}.docx`);
  });

  it('SSP constants', () => {
    expect(SSP_CONTENT_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(REQUIREMENT_STATUS_LABELS).toEqual({
      met: 'Met',
      not_met: 'Not Met',
      not_assessed: 'Not Assessed',
    });
    expect(REQUIREMENT_NOT_APPLICABLE_LABEL).toBe('Not Applicable');
    expect(OBJECTIVE_STATUS_LABELS).toEqual({
      met: 'Met',
      not_met: 'Not Met',
      na: 'N/A',
      not_assessed: 'Not Assessed',
    });
    expect(CONDITIONAL_STATUS_LABELS).toEqual({
      final: 'Final status reachable',
      conditional: 'Conditional status reachable',
      not_eligible: 'Not eligible',
      incomplete: 'Assessment incomplete',
    });
  });
});
