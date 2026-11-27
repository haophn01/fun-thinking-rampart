import { describe, expect, it } from 'vitest';
import { AUDIT_CHAIN_PROBLEMS, auditVerifyResponseSchema } from './index';

// nosemgrep: generic.secrets.security.detected-generic-secret — a made-up SHA-256 shape, not a secret
const HASH = 'ab'.repeat(32);
const AT = '2026-11-23T09:00:00.000Z';

const intact = {
  ok: true,
  checked: 3,
  total: 3,
  headHash: HASH,
  firstBroken: null,
  verifiedAt: AT,
};

const broken = {
  ok: false,
  checked: 1,
  total: 3,
  headHash: HASH,
  firstBroken: { id: 2, at: AT, action: 'auth.signed_in', problem: 'hash_mismatch' },
  verifiedAt: AT,
};

const accepts = (value: unknown) => auditVerifyResponseSchema.safeParse(value).success;

describe('auditVerifyResponseSchema edges', () => {
  it('auditVerifyResponseSchema edges', () => {
    expect(AUDIT_CHAIN_PROBLEMS).toEqual(['unchained', 'prev_mismatch', 'hash_mismatch']);

    // The two honest shapes, and an empty log.
    expect(accepts(intact)).toBe(true);
    expect(accepts(broken)).toBe(true);
    expect(accepts({ ...intact, checked: 0, total: 0, headHash: null })).toBe(true);
    // A newest row with no hash (the break) still says what it holds: null.
    expect(accepts({ ...broken, headHash: null })).toBe(true);

    // The refine: ok exactly when nothing is broken, and every row checked when ok.
    expect(accepts({ ...intact, firstBroken: broken.firstBroken })).toBe(false);
    expect(accepts({ ...broken, firstBroken: null })).toBe(false);
    expect(accepts({ ...intact, checked: 2 })).toBe(false);

    // A tampered row may hold anything in at and action.
    for (const odd of ['', 'not a date', 'drop table', '‮evil']) {
      expect(accepts({ ...broken, firstBroken: { ...broken.firstBroken, at: odd } }), odd).toBe(
        true,
      );
      expect(accepts({ ...broken, firstBroken: { ...broken.firstBroken, action: odd } }), odd).toBe(
        true,
      );
    }

    // Each problem is accepted; anything else is not.
    for (const problem of AUDIT_CHAIN_PROBLEMS) {
      expect(accepts({ ...broken, firstBroken: { ...broken.firstBroken, problem } })).toBe(true);
    }
    expect(accepts({ ...broken, firstBroken: { ...broken.firstBroken, problem: 'other' } })).toBe(
      false,
    );

    // Counts are whole and not negative; the hash is lowercase SHA-256 hex; verifiedAt is ISO.
    for (const bad of [-1, 1.5]) {
      expect(accepts({ ...broken, checked: bad }), String(bad)).toBe(false);
      expect(accepts({ ...broken, total: bad }), String(bad)).toBe(false);
    }
    expect(accepts({ ...intact, headHash: HASH.toUpperCase() })).toBe(false);
    expect(accepts({ ...intact, headHash: HASH.slice(1) })).toBe(false);
    expect(accepts({ ...intact, verifiedAt: 'yesterday' })).toBe(false);
    expect(accepts({ ...broken, firstBroken: { ...broken.firstBroken, id: 1.5 } })).toBe(false);
  });
});
