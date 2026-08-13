import { zStartShiftRequest } from '@dispatch/contracts';
import { startShift } from '@/src/server/modules/vehicles';
import { apiErrorResponse } from '@/src/server/infra/errors';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const raw = await request.text();
    const body = zStartShiftRequest.parse(raw ? JSON.parse(raw) : {});
    return Response.json(await startShift(id, body.crewUserIds), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
