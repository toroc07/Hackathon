import type { ApiError } from '@dispatch/contracts';

export type ApiErrorCode = ApiError['error']['code'];

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Misma forma de error que el resto de la plataforma (@dispatch/contracts `zApiError`). */
export function toApiError(error: unknown): { status: number; body: ApiError } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Error interno del servicio de audio' } } };
}
