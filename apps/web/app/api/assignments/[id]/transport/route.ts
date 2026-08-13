import { zAssignment, zTransportRequest } from '@dispatch/contracts';
import { startTransport } from '@/src/server/modules/dispatch';
import { dispatchApiError, optionalJson } from '@/app/api/dispatch/_shared';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const input = zTransportRequest.parse(await optionalJson(request));
    const { id } = await context.params;
    return Response.json(zAssignment.parse(startTransport(id, input.destinationFacilityId)));
  } catch (error) { return dispatchApiError(error); }
}
