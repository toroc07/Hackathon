import { HttpError } from '@/src/server/infra/errors';

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'VALIDATION_FAILED', 'El cuerpo debe ser JSON válido');
  }
}

export function readIdempotencyKey(request: Request): string | null {
  const value = request.headers.get('Idempotency-Key')?.trim() ?? '';
  if (!value) return null;
  if (value.length > 200) throw new HttpError(400, 'VALIDATION_FAILED', 'Idempotency-Key supera 200 caracteres');
  return value;
}
