import { InvalidTransitionError, type ApiError } from '@dispatch/contracts';
import { ZodError } from 'zod';

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

export function toApiError(error: unknown): { status: number; body: ApiError } {
  if (error instanceof InvalidTransitionError) {
    return {
      status: error.httpStatus,
      body: { error: { code: 'INVALID_TRANSITION', message: error.message, details: { entity: error.entity, from: error.from, to: error.to } } },
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: { error: { code: 'VALIDATION_FAILED', message: 'La solicitud no cumple el contrato', details: { issues: error.issues } } },
    };
  }
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } } };
  }
  if (error instanceof Error && 'code' in error && String(error.code).startsWith('SQLITE_CONSTRAINT')) {
    return { status: 409, body: { error: { code: 'VEHICLE_UNAVAILABLE', message: 'La operación entra en conflicto con el estado actual' } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Error interno de la plataforma' } } };
}

export function apiErrorResponse(error: unknown): Response {
  const mapped = toApiError(error);
  return Response.json(mapped.body, { status: mapped.status });
}
