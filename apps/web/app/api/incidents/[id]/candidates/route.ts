import { zDispatchResponse } from '@dispatch/contracts';
import { getCandidates } from '@/src/server/modules/dispatch';
import { dispatchApiError } from '@/app/api/dispatch/_shared';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    return Response.json(zDispatchResponse.parse(getCandidates(id)));
  } catch (error) {
    return dispatchApiError(error);
  }
}
