import { zUpdateVehicleStatusRequest } from '@dispatch/contracts';
import { setStatus } from '@/src/server/modules/vehicles';
import { getActiveAssignmentForVehicle } from '@/src/server/modules/vehicles';
import { markEnRoute } from '@/src/server/modules/dispatch';
import { apiErrorResponse } from '@/src/server/infra/errors';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const { status } = zUpdateVehicleStatusRequest.parse(await request.json());
    if (status === 'EN_ROUTE') {
      const active = getActiveAssignmentForVehicle(id);
      if (active?.assignment.status === 'ACCEPTED') {
        return Response.json(markEnRoute(active.assignment.id));
      }
    }
    return Response.json(setStatus(id, status));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
