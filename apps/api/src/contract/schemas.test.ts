import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ASSESSMENT_TYPE_LABELS,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  CLOSEOUT_CONFIRMER_LABELS,
  CSRF_HEADER,
  ERROR_CODES,
  ERROR_STATUS,
  FILE_INTEGRITY_MESSAGE,
  FILE_NAME_HEADER,
  SESSION_COOKIE,
  UPLOAD_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  assessmentTypeSchema,
  auditQuerySchema,
  calendarDateSchema,
  createUserRequestSchema,
  displayNameSchema,
  emailSchema,
  fileNameSchema,
  implementationLevelSchema,
  implementationStatementSchema,
  noteSchema,
  objectiveStatusSchema,
  passwordSchema,
  patchRequirementRequestSchema,
  putObjectiveResultRequestSchema,
  requirementStatusSchema,
  roleSchema,
  setupRequestSchema,
  sha256Schema,
  signInRequestSchema,
  updateAssessmentRequestSchema,
  updateUserRequestSchema,
  uploadProblem,
} from './index';

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

describe('contract schemas', () => {
  it('error codes and statuses', () => {
    const table = {
      not_found: 404,
      validation_failed: 400,
      payload_too_large: 413,
      db_unavailable: 503,
      internal_error: 500,
      unauthenticated: 401,
      invalid_credentials: 401,
      forbidden: 403,
      csrf_failed: 403,
      setup_complete: 409,
      email_taken: 409,
      last_admin: 409,
      unsupported_media_type: 415,
      too_many_attempts: 429,
      poam_ineligible: 409,
      poam_item_exists: 409,
      poam_item_closed: 409,
      closeout_not_ready: 409,
      cui_file_refused: 409,
      evidence_not_cui: 409,
      unsupported_file_type: 415,
      file_integrity_failed: 500,
    };
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(table).sort());
    expect(ERROR_STATUS).toEqual(table);
    for (const code of ERROR_CODES) expect(ERROR_STATUS[code], code).toBe(table[code]);
  });

  it('objective status is exact', () => {
    for (const status of ['met', 'not_met', 'na', 'not_assessed']) {
      expect(objectiveStatusSchema.parse(status)).toBe(status);
    }
    expect(objectiveStatusSchema.options).toEqual(['met', 'not_met', 'na', 'not_assessed']);
    for (const bad of ['Met', 'NOT_MET', '', null, undefined, ' met', 'n/a', 1]) {
      expect(accepts(objectiveStatusSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('other enums and constants', () => {
    expect(requirementStatusSchema.options).toEqual(['met', 'not_met', 'not_assessed']);
    expect(accepts(requirementStatusSchema, 'na')).toBe(false);
    expect(implementationLevelSchema.options).toEqual(['none', 'partial']);
    expect(assessmentTypeSchema.options).toEqual(['self', 'c3pao']);
    expect(roleSchema.options).toEqual(['admin', 'contributor']);
    expect(SESSION_COOKIE).toBe('rampart_session');
    expect(CSRF_HEADER).toBe('x-csrf-token');
    expect(ASSESSMENT_TYPE_LABELS).toEqual({
      self: 'Self-assessment',
      c3pao: 'C3PAO certification assessment',
    });
    expect(CLOSEOUT_CONFIRMER_LABELS).toEqual({
      organization: 'Your organization',
      c3pao: 'An authorized C3PAO',
    });
    expect(AUDIT_ACTIONS).toEqual([
      'user.created',
      'user.updated',
      'user.password_reset',
      'auth.signed_in',
      'auth.signed_out',
      'auth.locked_out',
      'assessment.created',
      'assessment.updated',
      'objective_result.updated',
      'requirement_state.updated',
    ]);
    expect(AUDIT_ENTITY_TYPES).toEqual([
      'user',
      'assessment',
      'objective_result',
      'requirement_state',
    ]);
  });

  it('calendar dates', () => {
    for (const good of ['2028-02-29', '2000-02-29', '2026-11-23', '2026-12-31', '2026-01-01']) {
      expect(calendarDateSchema.parse(good), good).toBe(good);
    }
    const bad = [
      '2027-02-29',
      '2026-02-30',
      '2026-2-3',
      '11/23/2026',
      '2100-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-11-23T00:00:00Z',
      ' 2026-11-23',
      '',
      null,
    ];
    for (const value of bad) {
      expect(accepts(calendarDateSchema, value), JSON.stringify(value)).toBe(false);
    }
  });

  it('identity fields', () => {
    expect(accepts(passwordSchema, 'a'.repeat(11))).toBe(false);
    expect(accepts(passwordSchema, 'a'.repeat(12))).toBe(true);
    expect(accepts(passwordSchema, 'a'.repeat(128))).toBe(true);
    expect(accepts(passwordSchema, 'a'.repeat(129))).toBe(false);
    // Not trimmed: the spaces are part of the password.
    expect(passwordSchema.parse('  ten chars!  ')).toBe('  ten chars!  ');
    expect(accepts(passwordSchema, `${' '.repeat(5)}abc${' '.repeat(5)}`)).toBe(true);

    expect(emailSchema.parse(' Admin@Example.COM ')).toBe('admin@example.com');
    expect(accepts(emailSchema, 'not-an-email')).toBe(false);
    expect(accepts(emailSchema, '')).toBe(false);
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    const at254 = `${local}@${domain}`;
    expect(at254.length).toBe(254);
    expect(accepts(emailSchema, at254)).toBe(true);
    expect(accepts(emailSchema, `${local}@x${domain}`)).toBe(false);

    expect(displayNameSchema.parse('  Ada Lovelace ')).toBe('Ada Lovelace');
    expect(accepts(displayNameSchema, '')).toBe(false);
    expect(accepts(displayNameSchema, '   ')).toBe(false);
    expect(accepts(displayNameSchema, 'x'.repeat(80))).toBe(true);
    expect(accepts(displayNameSchema, 'x'.repeat(81))).toBe(false);
    expect(displayNameSchema.parse(` ${'x'.repeat(80)} `)).toBe('x'.repeat(80));
  });

  it('text limits', () => {
    expect(noteSchema.parse('  checked the logs  ')).toBe('checked the logs');
    expect(noteSchema.parse('   ')).toBeNull();
    expect(noteSchema.parse('\n\t ')).toBeNull();
    expect(noteSchema.parse('')).toBeNull();
    expect(noteSchema.parse(null)).toBeNull();
    expect(accepts(noteSchema, undefined)).toBe(false);
    expect(accepts(noteSchema, 'n'.repeat(4000))).toBe(true);
    expect(accepts(noteSchema, 'n'.repeat(4001))).toBe(false);
    expect(noteSchema.parse(`  ${'n'.repeat(4000)}  `)).toBe('n'.repeat(4000));

    expect(implementationStatementSchema.parse('  We use MFA.  ')).toBe('We use MFA.');
    expect(implementationStatementSchema.parse(' ')).toBeNull();
    expect(implementationStatementSchema.parse(null)).toBeNull();
    expect(accepts(implementationStatementSchema, 's'.repeat(20000))).toBe(true);
    expect(accepts(implementationStatementSchema, 's'.repeat(20001))).toBe(false);
  });

  it('strict requests', () => {
    const owner = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
    const valid: [string, z.ZodType, Record<string, unknown>][] = [
      [
        'setup',
        setupRequestSchema,
        { email: 'a@x.com', displayName: 'Ada', password: 'correct horse' },
      ],
      ['signIn', signInRequestSchema, { email: 'a@x.com', password: 'p' }],
      [
        'createUser',
        createUserRequestSchema,
        { email: 'b@x.com', displayName: 'Bo', role: 'contributor', password: 'correct horse' },
      ],
      ['updateUser', updateUserRequestSchema, { active: false }],
      ['updateAssessment', updateAssessmentRequestSchema, { conditionalStatusDate: null }],
      ['putObjectiveResult', putObjectiveResultRequestSchema, { status: 'met', note: null }],
      ['patchRequirement', patchRequirementRequestSchema, { ownerId: owner }],
    ];
    for (const [name, schema, body] of valid) {
      expect(accepts(schema, body), `${name} valid`).toBe(true);
      expect(accepts(schema, { ...body, extra: 1 }), `${name} with an unknown key`).toBe(false);
    }

    for (const schema of [
      updateUserRequestSchema,
      updateAssessmentRequestSchema,
      patchRequirementRequestSchema,
    ]) {
      expect(accepts(schema, {})).toBe(false);
    }

    // Sign-in: trimmed and lowercased, but no format check, so a typo still gets one message.
    expect(signInRequestSchema.parse({ email: ' Not An Email ', password: 'x' })).toEqual({
      email: 'not an email',
      password: 'x',
    });
    expect(accepts(signInRequestSchema, { email: '  ', password: 'x' })).toBe(false);
    expect(accepts(signInRequestSchema, { email: 'a@x.com', password: '' })).toBe(false);
    expect(accepts(signInRequestSchema, { email: 'a@x.com', password: 'p'.repeat(129) })).toBe(
      false,
    );
    expect(accepts(signInRequestSchema, { email: 'e'.repeat(255), password: 'x' })).toBe(false);

    // Put needs both keys; null note is fine, a missing one is not.
    expect(accepts(putObjectiveResultRequestSchema, { status: 'met' })).toBe(false);
    expect(accepts(putObjectiveResultRequestSchema, { status: 'Met', note: null })).toBe(false);
    expect(putObjectiveResultRequestSchema.parse({ status: 'na', note: '  ' })).toEqual({
      status: 'na',
      note: null,
    });

    expect(accepts(updateUserRequestSchema, { role: 'owner' })).toBe(false);
    expect(accepts(updateUserRequestSchema, { password: 'short' })).toBe(false);
    expect(accepts(updateAssessmentRequestSchema, { conditionalStatusDate: '2027-02-29' })).toBe(
      false,
    );
    expect(accepts(updateAssessmentRequestSchema, { type: 'c3pao' })).toBe(true);
    expect(accepts(patchRequirementRequestSchema, { ownerId: 'not-a-uuid' })).toBe(false);
    expect(accepts(patchRequirementRequestSchema, { ownerId: null })).toBe(true);
    expect(accepts(patchRequirementRequestSchema, { implementationLevel: null })).toBe(true);
    expect(accepts(patchRequirementRequestSchema, { implementationLevel: 'full' })).toBe(false);
    expect(patchRequirementRequestSchema.parse({ implementationStatement: '  ' })).toEqual({
      implementationStatement: null,
    });
  });

  it('audit query', () => {
    expect(auditQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(auditQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    expect(auditQuerySchema.parse({ limit: '200' }).limit).toBe(200);
    for (const limit of ['0', '201', '1.5', 'ten', '']) {
      expect(accepts(auditQuerySchema, { limit }), `limit=${limit}`).toBe(false);
    }
    expect(accepts(auditQuerySchema, { before: '0' })).toBe(false);
    expect(auditQuerySchema.parse({ before: '1' })).toEqual({ limit: 50, before: 1 });
    expect(
      auditQuerySchema.parse({ entityType: 'objective_result', entityId: '3.1.1[a]' }),
    ).toEqual({ limit: 50, entityType: 'objective_result', entityId: '3.1.1[a]' });
    expect(accepts(auditQuerySchema, { entityType: 'session' })).toBe(false);
    expect(accepts(auditQuerySchema, { entityId: '' })).toBe(false);
    expect(accepts(auditQuerySchema, { entityId: 'i'.repeat(64) })).toBe(true);
    expect(accepts(auditQuerySchema, { entityId: 'i'.repeat(65) })).toBe(false);
  });

  it('upload protocol constants', () => {
    expect(FILE_NAME_HEADER).toBe('x-file-name');
    expect(UPLOAD_MAX_BYTES).toBe(26_214_400);
    expect(UPLOAD_EXTENSIONS).toEqual([
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
    ]);
    expect(FILE_INTEGRITY_MESSAGE).toBe(
      "The stored file is missing or doesn't match its recorded SHA-256.",
    );

    const hash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(sha256Schema.parse(hash)).toBe(hash);
    for (const bad of [hash.toUpperCase(), hash.slice(1), `${hash}0`, `${hash.slice(1)}g`, '']) {
      expect(accepts(sha256Schema, bad), bad).toBe(false);
    }

    expect(fileNameSchema.parse('  Política 1.pdf  ')).toBe('Política 1.pdf');
    expect(accepts(fileNameSchema, 'n'.repeat(255))).toBe(true);
    expect(fileNameSchema.parse(` ${'n'.repeat(255)} `)).toBe('n'.repeat(255));
    expect(accepts(fileNameSchema, '...')).toBe(true);
    const badNames = [
      '',
      '   ',
      'n'.repeat(256),
      'a/b.pdf',
      'a\b.pdf',
      '.',
      '..',
      ' .. ',
      'a\u0000.pdf',
      'a\u0007.pdf',
      'a\u001f.pdf',
      'a\u007f.pdf',
      'a\nb.pdf',
      null,
    ];
    for (const bad of badNames) {
      expect(accepts(fileNameSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('uploadProblem edges', () => {
    const max = 26_214_400;
    const cases: [string, number, ReturnType<typeof uploadProblem>][] = [
      ['report.pdf', 10, null],
      ['a/b.pdf', 10, 'invalid_file_name'],
      ['a\b.pdf', 10, 'invalid_file_name'],
      ['.', 10, 'invalid_file_name'],
      ['..', 10, 'invalid_file_name'],
      ['', 10, 'invalid_file_name'],
      ['bell\u0007.pdf', 10, 'invalid_file_name'],
      [`${'x'.repeat(252)}.pdf`, 10, 'invalid_file_name'],
      [`${'x'.repeat(251)}.pdf`, 10, null],
      ['a.pdf.exe', 10, 'unsupported_file_type'],
      ['a.exe.pdf', 10, null],
      ['REPORT.PDF', 10, null],
      ['Notes.Md', 10, null],
      ['README', 10, 'unsupported_file_type'],
      ['.pdf', 10, 'unsupported_file_type'],
      ['a.pdf.', 10, 'unsupported_file_type'],
      ['a.pdf', 0, 'empty'],
      ['a.pdf', 1, null],
      ['a.pdf', max, null],
      ['a.pdf', max + 1, 'too_large'],
      // Checked in order: name, then type, then empty, then size.
      ['a/b.exe', 0, 'invalid_file_name'],
      ['a.exe', 0, 'unsupported_file_type'],
      ['a.exe', max + 1, 'unsupported_file_type'],
    ];
    for (const [name, size, problem] of cases) {
      expect(uploadProblem(name, size), `${JSON.stringify(name)} at ${String(size)}`).toBe(
        problem,
      );
    }
    for (const extension of UPLOAD_EXTENSIONS) {
      expect(uploadProblem(`file${extension}`, 1), extension).toBeNull();
      expect(uploadProblem(`FILE${extension.toUpperCase()}`, 1), extension).toBeNull();
    }
  });
});
