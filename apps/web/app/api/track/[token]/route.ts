import { zIncidentType } from '@dispatch/contracts';
import { apiErrorResponse, HttpError } from '@/src/server/infra/errors';
import { confirmIncidentType, getTracking } from '@/src/server/modules/incidents';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/track/:token — seguimiento publico del incidente, sin login.
 *
 * El token es opaco y de 128 bits: a diferencia del codigo INC-482, no se puede
 * enumerar para espiar emergencias ajenas.
 *
 * Lo consulta el cliente por polling cada pocos segundos. No usamos SSE aqui a
 * proposito: en serverless el bus de eventos vive en memoria de una instancia y
 * no llegaria a los clientes conectados a otra.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const { token } = await params;
    const tracking = await getTracking(token);
    if (!tracking) throw new HttpError(404, 'NOT_FOUND', 'Seguimiento no encontrado');

    return Response.json(tracking, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * POST /api/track/:token — el ciudadano confirma el tipo de emergencia cuando
 * la transcripcion no fue concluyente.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const { token } = await params;
    const body = (await request.json()) as { type?: unknown };
    const type = zIncidentType.parse(body.type);

    await confirmIncidentType(token, type);

    const tracking = await getTracking(token);
    if (!tracking) throw new HttpError(404, 'NOT_FOUND', 'Seguimiento no encontrado');
    return Response.json(tracking);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
