import { MAX_AUDIO_BYTES, zAudioReportRequest } from '@dispatch/contracts';
import { apiErrorResponse, HttpError } from '@/src/server/infra/errors';
import { createIncidentFromAudio } from '@/src/server/modules/incidents';
import { runDispatch } from '@/src/server/modules/dispatch';
import { readIdempotencyKey, readJson } from '../_shared';

export const dynamic = 'force-dynamic';
// `pg` y la transcripcion necesitan APIs de Node; el edge runtime no sirve.
export const runtime = 'nodejs';
// La transcripcion tiene un presupuesto de 12s; damos margen al resto.
export const maxDuration = 30;

/**
 * POST /api/incidents/audio — entrada por voz del ciudadano.
 *
 * Sin login (§2A del brief): quien presencia un accidente no se registra
 * primero. Devuelve un token de seguimiento para que pueda ver la ambulancia
 * en camino sin cuenta.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const input = zAudioReportRequest.parse(await readJson(request));

    // El tope tambien se valida aqui, no solo en el cliente: un cliente puede
    // mentir, y decodificar 50 MB de base64 tumbaria la funcion.
    const approximateBytes = Math.floor((input.audioBase64.length * 3) / 4);
    if (approximateBytes > MAX_AUDIO_BYTES) {
      throw new HttpError(
        400,
        'VALIDATION_FAILED',
        `El audio supera el máximo de ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB`,
      );
    }

    const result = await createIncidentFromAudio(input, {
      idempotencyKey: readIdempotencyKey(request),
      actorType: 'REPORTER',
    });

    // No hay Command Center: el único panel de ambulancia (universal, es
    // demo) depende de que la asignación exista apenas llega el reporte. Si
    // el despacho falla (p. ej. ninguna unidad con ubicación fresca) el
    // ciudadano igual recibe su código de seguimiento — el panel simplemente
    // no verá asignación todavía.
    if (!result.wasMerged) {
      try {
        await runDispatch(result.incidentId, { mode: 'AUTO_ASSIGN' }, { triggeredBy: 'AUTO' });
      } catch (dispatchError) {
        console.error('auto-dispatch falló tras reporte de audio', dispatchError);
      }
    }

    return Response.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
