import { zIncident, zIncidentDetailResponse, zUpdateIncidentRequest } from '@dispatch/contracts';
import { apiErrorResponse, HttpError } from '@/src/server/infra/errors';
import { getIncidentDetail, updateIncident } from '@/src/server/modules/incidents';
import { readJson } from '../_shared';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { id } = await context.params;
    return Response.json(zIncidentDetailResponse.parse(getIncidentDetail(id)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  try {
    const raw = await readJson(request);
    if (raw && typeof raw === 'object' && 'status' in raw) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'Los clientes envían acciones, no status');
    }
    const input = zUpdateIncidentRequest.parse(raw);
    const { id } = await context.params;
    return Response.json(zIncident.parse(updateIncident(id, input)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
