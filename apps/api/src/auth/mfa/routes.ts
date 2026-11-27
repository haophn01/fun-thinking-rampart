// The session's MFA routes: enroll (a new pending secret), confirm (finish enrollment, recovery
// codes) and verify (the sign-in challenge). Registered inside the guarded plugin: each needs a
// session and the CSRF token. The guard doesn't gate on MFA yet (A2 does).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { recordAudit } from '../../audit/record';
import {
  ERROR_MESSAGES,
  PRODUCT_NAME,
  mfaConfirmRequestSchema,
  mfaEnrolledResponseSchema,
  mfaEnrollmentResponseSchema,
  type MfaEnrolledResponse,
  type MfaEnrollmentResponse,
  type SessionResponse,
} from '../../contract';
import { AppError } from '../../errors';
import { respond } from '../../respond';
import type { ApiDeps } from '../../routes';
import { decryptSecret, encryptSecret } from '../../security/secrets';
import { getSignInNotice } from '../../settings/repository';
import { setSessionCookie } from '../cookie';
import { rotateSession, type ActiveSession } from '../sessions';
import { base32Decode, base32Encode } from './base32';
import { qrPath } from './qr';
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from './recovery-codes';
import {
  findMfaAccount,
  markEnrolled,
  replaceRecoveryCodes,
  storePendingSecret,
  type MfaAccount,
} from './repository';
import { generateSecret, matchTotp, otpauthUri } from './totp';

const SIGNED_OUT = 'Sign in to continue.';

function sessionOf(request: FastifyRequest): ActiveSession {
  if (request.auth === null) throw new AppError('unauthenticated', SIGNED_OUT);
  return request.auth;
}

function accountOf(deps: ApiDeps, userId: string): MfaAccount {
  const account = findMfaAccount(deps.db, userId);
  if (!account) throw new AppError('unauthenticated', SIGNED_OUT);
  return account;
}

function wrongStep(): AppError {
  return new AppError('mfa_wrong_step', ERROR_MESSAGES.mfa_wrong_step);
}

function invalidCode(): AppError {
  return new AppError('invalid_mfa_code', ERROR_MESSAGES.invalid_mfa_code);
}

/** What an MFA secret is sealed to: its user, so a row copied to another user won't open. */
function secretAad(userId: string): string {
  return `user:${userId}`;
}

/**
 * The stored secret's bytes. One that won't decrypt (the key changed) is logged by user id only
 * and answers a generic 500: an admin reset or the CLI recovers the account.
 */
function storedSecret(deps: ApiDeps, request: FastifyRequest, account: MfaAccount): Buffer {
  try {
    if (account.secretEnc === null) throw new Error('no stored secret');
    return base32Decode(
      decryptSecret(deps.keys.mfaSecret, account.secretEnc, secretAad(account.id)),
    );
  } catch {
    request.log.error({ userId: account.id }, 'The stored MFA secret could not be decrypted');
    throw new Error('The stored MFA secret could not be decrypted');
  }
}

/** The full session's answer after an MFA step, with the (rotated) session's CSRF token. */
function fullSession(
  deps: ApiDeps,
  auth: ActiveSession,
  account: MfaAccount,
  csrfToken: string,
): SessionResponse {
  return {
    setupRequired: false,
    user: auth.user,
    csrfToken,
    locked: false,
    mustChangePassword: account.mustChangePassword,
    signInNotice: getSignInNotice(deps.db),
    mfa: 'none',
  };
}

/**
 * `POST /api/session/mfa/enroll`: a new secret, stored sealed in place of any pending one, with
 * the last step cleared. Not audited: only finishing enrollment is. 409 once enrolled.
 */
function enroll(deps: ApiDeps, request: FastifyRequest): MfaEnrollmentResponse {
  const auth = sessionOf(request);
  const account = accountOf(deps, auth.user.id);
  if (account.enrolledAt !== null) throw wrongStep();
  const secret = generateSecret();
  const encoded = base32Encode(secret);
  const sealed = encryptSecret(deps.keys.mfaSecret, encoded, secretAad(account.id));
  if (!storePendingSecret(deps.db, account.id, sealed, deps.now())) throw wrongStep();
  const uri = otpauthUri({ issuer: PRODUCT_NAME, account: account.email, secret });
  return { secret: encoded, otpauthUri: uri, qr: qrPath(uri) };
}

/** Ten new recovery codes, as shown once, and the hashes stored in their place. */
function newRecoveryCodes(deps: ApiDeps): { codes: string[]; hashes: string[] } {
  const codes = generateRecoveryCodes();
  const hashes = codes.map((code) => {
    const normalized = normalizeRecoveryCode(code);
    if (normalized === null) throw new Error('a generated recovery code did not normalize');
    return hashRecoveryCode(deps.keys.recoveryCode, normalized);
  });
  return { codes, hashes };
}

/**
 * `POST /api/session/mfa/enroll/confirm`, in order: body, state (409 unless a secret is pending),
 * code. A wrong code is 401 and never counts in the lockout. A right one, in one transaction,
 * enrolls the user at the matched step, replaces their recovery codes, rotates the session (not
 * pending) and writes `auth.mfa_enrolled`.
 */
function confirm(deps: ApiDeps, request: FastifyRequest, reply: FastifyReply): MfaEnrolledResponse {
  const auth = sessionOf(request);
  const body = mfaConfirmRequestSchema.parse(request.body);
  const account = accountOf(deps, auth.user.id);
  const pendingSecret = account.secretEnc;
  if (account.enrolledAt !== null || pendingSecret === null) throw wrongStep();
  const now = deps.now();
  const step = matchTotp(storedSecret(deps, request, account), body.code, now);
  if (step === null) throw invalidCode();
  const { codes, hashes } = newRecoveryCodes(deps);

  const rotated = deps.db.transaction((tx) => {
    // A newer enroll replaced the secret, or another confirm finished first.
    if (!markEnrolled(tx, account.id, pendingSecret, step, now)) throw wrongStep();
    replaceRecoveryCodes(tx, account.id, hashes, now);
    const next = rotateSession(tx, auth.id, now);
    if (next === null) throw new AppError('unauthenticated', SIGNED_OUT);
    recordAudit(tx, {
      at: now,
      actorUserId: account.id,
      action: 'auth.mfa_enrolled',
      entityType: 'user',
      entityId: account.id,
      before: null,
      after: null,
      requestId: request.id,
    });
    return next;
  });
  setSessionCookie(reply, deps, rotated.token);
  return { ...fullSession(deps, auth, account, rotated.csrfToken), recoveryCodes: codes };
}

/** The session's MFA routes. Inside the guarded plugin: each needs a session and CSRF. */
export function registerMfaRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/api/session/mfa/enroll', (request) =>
    respond(mfaEnrollmentResponseSchema, enroll(deps, request)),
  );

  app.post('/api/session/mfa/enroll/confirm', (request, reply) =>
    respond(mfaEnrolledResponseSchema, confirm(deps, request, reply)),
  );
}
