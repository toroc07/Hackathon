import { zCreateIncidentRequest, zCreateIncidentResponse } from '@dispatch/contracts';
import { apiErrorResponse } from '@/src/server/infra/errors';
import { createIncidentFromReport, listLiveIncidents } from '@/src/server/modules/incidents';
import { runDispatch } from '@/src/server/modules/dispatch';
import { readIdempotencyKey, readJson } from './_shared';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await listLiveIncidents());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = zCreateIncidentRequest.parse(await readJson(request));
    const result = await createIncidentFromReport(input, { idempotencyKey: readIdempotencyKey(request) });
    if (!result.wasMerged) {
      try {
        await runDispatch(result.incident.id, { mode: 'AUTO_ASSIGN' }, { triggeredBy: 'AUTO' });
      } catch (dispatchError) {
        console.error('auto-dispatch falló tras reporte', dispatchError);
      }
    }
    return Response.json(zCreateIncidentResponse.parse(result), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
