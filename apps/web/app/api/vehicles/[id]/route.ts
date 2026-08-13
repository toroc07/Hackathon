import { getActiveAssignmentForVehicle, getVehicle } from '@/src/server/modules/vehicles';
import { apiErrorResponse } from '@/src/server/infra/errors';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    return Response.json({
      vehicle: getVehicle(id),
      activeAssignment: getActiveAssignmentForVehicle(id),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
