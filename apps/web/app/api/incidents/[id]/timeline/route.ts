import { apiErrorResponse } from '@/src/server/infra/errors';
import { getIncidentDetail } from '@/src/server/modules/incidents';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { id } = await context.params;
    return Response.json({ events: (await getIncidentDetail(id)).events });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
