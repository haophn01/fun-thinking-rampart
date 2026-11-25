import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from '../../db/client';
import { AppError } from '../errors';
import { changedFields, newId, requireAssessmentId, utcDate } from './common';

const open: DbHandle[] = [];

afterEach(() => {
  for (const handle of open.splice(0)) if (handle.sqlite.open) handle.sqlite.close();
});

function migrated(): DbHandle {
  const handle = openDb(':memory:');
  open.push(handle);
  runMigrations(handle.db);
  return handle;
}

describe('ssp-data common', () => {
  it('shared helpers', () => {
    // utcDate: the UTC day, whatever the offset the instant was written with.
    expect(utcDate(new Date('2026-11-25T23:59:59.999Z'))).toBe('2026-11-25');
    expect(utcDate(new Date('2026-11-26T00:00:00.000Z'))).toBe('2026-11-26');
    expect(utcDate(new Date('2026-11-25T16:30:00.000-08:00'))).toBe('2026-11-26');
    expect(utcDate(new Date('2026-11-26T00:30:00.000+01:00'))).toBe('2026-11-25');
    expect(utcDate(new Date('2028-02-29T12:00:00.000Z'))).toBe('2028-02-29');

    // requireAssessmentId: not_found with no assessment, else the earliest-created one.
    const handle = migrated();
    let thrown: unknown;
    try {
      requireAssessmentId(handle.db);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('not_found');
    expect((thrown as AppError).statusCode).toBe(404);
    const add = handle.sqlite.prepare(
      `insert into assessment (id, catalog_version, created_at, updated_at) values (?, 'v', ?, ?)`,
    );
    add.run('later', '2026-11-25T00:00:00.001Z', '2026-11-25T00:00:00.001Z');
    add.run('first', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z');
    expect(requireAssessmentId(handle.db)).toBe('first');

    // changedFields: undefined means "not sent", equal values are no change, null is a value.
    const current = { name: 'Server', owner: null as string | null, count: 2, kept: 'x' };
    expect(
      changedFields(current, { name: 'Server', owner: undefined, count: 2 }, [
        'name',
        'owner',
        'count',
        'kept',
      ]),
    ).toEqual({ before: {}, after: {} });
    expect(
      changedFields(current, { name: 'File server', owner: 'Pat', count: 0, kept: 'x' }, [
        'name',
        'owner',
        'count',
        'kept',
      ]),
    ).toEqual({
      before: { name: 'Server', owner: null, count: 2 },
      after: { name: 'File server', owner: 'Pat', count: 0 },
    });
    const owned: typeof current = { ...current, owner: 'Pat' };
    expect(changedFields(owned, { owner: null }, ['owner'])).toEqual({
      before: { owner: 'Pat' },
      after: { owner: null },
    });
    // Only the keys asked for are compared.
    expect(changedFields(current, { name: 'Other' }, ['owner'])).toEqual({ before: {}, after: {} });

    // newId: a fresh v4 UUID each call.
    const ids = new Set(Array.from({ length: 50 }, () => newId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
