import { zDispatchRequest, zDispatchResponse } from '@dispatch/contracts';
import { runDispatch } from '@/src/server/modules/dispatch';
import { dispatchApiError, optionalJson } from '@/app/api/dispatch/_shared';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const input = zDispatchRequest.parse(await optionalJson(request));
    const result = await runDispatch(id, input, {
      idempotencyKey: request.headers.get('Idempotency-Key'),
      triggeredBy: 'DISPATCHER',
    });
    return Response.json(zDispatchResponse.parse(result));
  } catch (error) {
    return dispatchApiError(error);
  }
}
