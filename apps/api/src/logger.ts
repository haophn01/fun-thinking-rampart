import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { pino, type DestinationStream } from 'pino';
import type { LogLevel } from './config';

/**
 * Keys whose value is a credential wherever it shows up: passwords, the CSRF and session tokens,
 * and the MFA codes and secrets later sprints add. `code` is censored too, so a log field holding
 * an error code needs another name (`errorCode`).
 */
export const SECRET_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'csrfToken',
  'token',
  'code',
  'recoveryCode',
  'secret',
  // sec-mfa: the enrollment URI carries the TOTP secret; recovery codes are shown once.
  'otpauthUri',
  'recoveryCodes',
] as const;

/** Secrets that must never reach a log line. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["proxy-authorization"]',
  // Bound to the session, so not a credential alone, but it never belongs in a log.
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  // Credential keys a log call might carry, at the top level and one level down (`body.x`).
  ...SECRET_KEYS.flatMap((key) => [key, `*.${key}`]),
];

function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: request.url,
    // A copy, so redaction never touches the live headers.
    headers: { ...request.headers },
    remoteAddress: request.ip,
  };
}

function serializeReply(reply: FastifyReply) {
  return { statusCode: reply.statusCode, headers: reply.getHeaders() };
}

/**
 * The api's pino logger: JSON lines to stdout (or `stream`), with secrets redacted. Typed as
 * Fastify's base logger so `loggerInstance` keeps the default `FastifyInstance` type.
 */
export function createLogger(level: LogLevel, stream?: DestinationStream): FastifyBaseLogger {
  const options = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    serializers: { req: serializeRequest, res: serializeReply, err: pino.stdSerializers.err },
  };
  return stream === undefined ? pino(options) : pino(options, stream);
}
