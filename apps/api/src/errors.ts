import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ERROR_STATUS, errorEnvelopeSchema, type ErrorCode, type ErrorEnvelope } from './contract';
import { ResponseContractError } from './respond';

/** An error a handler throws on purpose; it becomes an envelope with its code and message. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly details: unknown;

  constructor(
    readonly code: ErrorCode,
    message: string,
    options: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = ERROR_STATUS[code];
    this.details = options.details;
  }
}

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

export interface ErrorResponse {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/** Fastify's own client errors (bad JSON, body too large, wrong media type) carry an FST_ code. */
function isFastifyClientError(
  error: unknown,
): error is Error & { code: string; statusCode: number } {
  if (!(error instanceof Error)) return false;
  const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
  return (
    typeof code === 'string' &&
    code.startsWith('FST_') &&
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
  );
}

/**
 * Maps anything a request can throw to the response the client sees. Only errors the api raised on
 * purpose, zod input errors and Fastify's own client errors keep their message; everything else is
 * a generic 500 so no internals leak.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof z.ZodError) {
    return {
      statusCode: ERROR_STATUS.validation_failed,
      code: 'validation_failed',
      message: 'The request is not valid',
      details: error.issues,
    };
  }
  if (isFastifyClientError(error)) {
    if (error.statusCode === 413) {
      return { statusCode: 413, code: 'payload_too_large', message: error.message };
    }
    if (error.statusCode === 404) {
      return { statusCode: 404, code: 'not_found', message: error.message };
    }
    if (error.statusCode === 415) {
      return {
        statusCode: 415,
        code: 'unsupported_media_type',
        message: 'The request body must be application/json',
      };
    }
    // Malformed JSON, an empty JSON body or a bad content-length (400).
    return { statusCode: error.statusCode, code: 'validation_failed', message: error.message };
  }
  return { statusCode: 500, code: 'internal_error', message: INTERNAL_ERROR_MESSAGE };
}

function envelope(response: ErrorResponse, requestId: string): ErrorEnvelope {
  return errorEnvelopeSchema.parse({
    error: {
      code: response.code,
      message: response.message,
      requestId,
      ...(response.details === undefined ? {} : { details: response.details }),
    },
  });
}

function sendNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const response: ErrorResponse = {
    statusCode: 404,
    code: 'not_found',
    message: `No route for ${request.method} ${request.url.split('?')[0] ?? ''}`,
  };
  return reply.code(404).send(envelope(response, request.id));
}

/**
 * Answers an unknown route with 404 before its body is read, so malformed JSON, an oversize body
 * or a wrong content type can't turn a missing route into a 400, 413 or 415.
 */
export function registerEarlyNotFound(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.is404) await sendNotFound(request, reply);
  });
}

/** Sends every error and every unknown route as the contract's error envelope. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const response = toErrorResponse(error);
    if (response.statusCode >= 500) {
      const message =
        error instanceof ResponseContractError
          ? 'response failed its contract schema'
          : 'request failed';
      request.log.error({ err: error }, message);
    } else {
      request.log.info({ errorCode: response.code }, 'request rejected');
    }
    return reply.code(response.statusCode).send(envelope(response, request.id));
  });

  app.setNotFoundHandler(sendNotFound);
}
