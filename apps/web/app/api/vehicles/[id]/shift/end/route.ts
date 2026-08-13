import { endShift } from '@/src/server/modules/vehicles';
import { apiErrorResponse } from '@/src/server/infra/errors';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    return Response.json(endShift(id));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
