import { zPostLocationRequest } from '@dispatch/contracts';
import { recordLocations } from '@/src/server/modules/vehicles';
import { apiErrorResponse } from '@/src/server/infra/errors';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const body = zPostLocationRequest.parse(await request.json());
    const positions = await recordLocations(id, body.positions);
    return Response.json({ positions, accepted: positions.length }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
