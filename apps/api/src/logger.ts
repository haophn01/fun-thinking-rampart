import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { pino, type DestinationStream } from 'pino';
import type { LogLevel } from './config';

/** Secrets that must never reach a log line. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
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
