import { listVehicles } from '@/src/server/modules/vehicles';
import { apiErrorResponse } from '@/src/server/infra/errors';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    return Response.json(listVehicles({ availableOnly: true }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
