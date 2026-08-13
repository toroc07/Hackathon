import { apiErrorResponse } from '@/src/server/infra/errors';

export function dispatchApiError(error: unknown): Response {
  if (error instanceof Error && 'httpStatus' in error && 'code' in error) {
    return Response.json({ error: { code: String(error.code), message: error.message } }, { status: Number(error.httpStatus) });
  }
  return apiErrorResponse(error);
}

export async function optionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}
