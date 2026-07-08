import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** Application error carrying the HTTP status and stable error code for the response envelope. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const validationError = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError(400, 'VALIDATION_ERROR', message, details);

export const notFound = (message = 'Resource not found.'): ApiError =>
  new ApiError(404, 'NOT_FOUND', message);

export const payloadTooLarge = (message: string): ApiError =>
  new ApiError(413, 'PAYLOAD_TOO_LARGE', message);

export const unsupportedMediaType = (message: string): ApiError =>
  new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', message);

interface ErrorEnvelope {
  error: { code: string; message: string; details: Record<string, unknown> };
}

function envelope(code: string, message: string, details?: Record<string, unknown>): ErrorEnvelope {
  return { error: { code, message, details: details ?? {} } };
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  void reply
    .code(404)
    .send(envelope('NOT_FOUND', `Route ${request.method} ${request.url} not found.`));
}

/**
 * Maps every thrown error onto the standard envelope. Unexpected errors are logged
 * with full detail but returned to the client as an opaque 500 (no stack traces leak).
 */
export function errorHandler(
  error: FastifyError | ApiError | ZodError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof ApiError) {
    void reply.code(error.statusCode).send(envelope(error.code, error.message, error.details));
    return;
  }

  if (error instanceof ZodError) {
    void reply.code(400).send(
      envelope('VALIDATION_ERROR', 'Invalid request input.', {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    );
    return;
  }

  const fastifyError = error as FastifyError;
  if (fastifyError.code === 'FST_REQ_FILE_TOO_LARGE') {
    void reply
      .code(413)
      .send(envelope('PAYLOAD_TOO_LARGE', 'File exceeds the maximum allowed upload size.'));
    return;
  }
  if (fastifyError.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
    void reply
      .code(415)
      .send(envelope('UNSUPPORTED_MEDIA_TYPE', 'Request body must be multipart/form-data.'));
    return;
  }
  // Other framework-raised client errors (bad content type, parts limits, ...): keep the
  // status but normalize the body to the envelope.
  if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
    void reply
      .code(fastifyError.statusCode)
      .send(envelope('VALIDATION_ERROR', fastifyError.message));
    return;
  }

  request.log.error({ err: error }, 'unhandled error');
  void reply.code(500).send(envelope('INTERNAL_ERROR', 'An unexpected error occurred.'));
}
