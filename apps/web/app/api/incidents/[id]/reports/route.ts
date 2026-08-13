import { zCreateIncidentRequest, zCreateIncidentResponse } from '@dispatch/contracts';
import { apiErrorResponse } from '@/src/server/infra/errors';
import { appendReportToIncident } from '@/src/server/modules/incidents';
import { readIdempotencyKey, readJson } from '../../_shared';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const input = zCreateIncidentRequest.parse(await readJson(request));
    const { id } = await context.params;
    const result = await appendReportToIncident(id, input, {
      idempotencyKey: readIdempotencyKey(request),
      actorType: 'DISPATCHER',
    });
    return Response.json(zCreateIncidentResponse.parse(result), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
