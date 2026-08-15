import { apiErrorResponse, HttpError } from '@/src/server/infra/errors';
import { straightLineRoute, type RouteResult } from '@/src/lib/routing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/routing?fromLat&fromLng&toLat&toLng — ruta por calles reales.
 *
 * Proxy al servicio de Python (backend/routing/routing_service.py), que corre
 * el A* sobre el grafo vial de OpenStreetMap de Cartagena. Va por el servidor
 * y no directo desde el navegador por dos razones: la URL del servicio no se
 * publica al cliente, y aquí podemos degradar a línea recta si el servicio
 * está dormido o caído — el mapa nunca se queda vacío, solo deja de decir
 * "por calles".
 *
 * El grafo es de solo lectura y no depende de la base de datos: si esto falla,
 * el despacho sigue funcionando igual.
 */

const ROUTING_URL = process.env.ROUTING_SERVICE_URL ?? 'http://127.0.0.1:4002';

/** Un mapa que tarda 6 s en pintar la ruta es peor que uno que pinta la recta
 *  al instante: en una emergencia el usuario ya está mirando la pantalla. */
const TIMEOUT_MS = Number(process.env.ROUTING_TIMEOUT_MS ?? 6_000);

interface GraphRouteResponse {
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  durationText: string;
  approximate: boolean;
}

function coordinate(params: URLSearchParams, name: string, limit: number): number {
  const raw = params.get(name);
  const value = Number(raw);
  if (raw === null || !Number.isFinite(value) || Math.abs(value) > limit) {
    throw new HttpError(400, 'VALIDATION_FAILED', `Parámetro inválido: ${name}`);
  }
  return value;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const from = { lat: coordinate(params, 'fromLat', 90), lng: coordinate(params, 'fromLng', 180) };
    const to = { lat: coordinate(params, 'toLat', 90), lng: coordinate(params, 'toLng', 180) };

    let route: RouteResult;
    try {
      const url = new URL('/route', ROUTING_URL);
      url.searchParams.set('fromLat', String(from.lat));
      url.searchParams.set('fromLng', String(from.lng));
      url.searchParams.set('toLat', String(to.lat));
      url.searchParams.set('toLng', String(to.lng));

      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`routing-service ${response.status}`);

      const graph = (await response.json()) as GraphRouteResponse;
      if (!Array.isArray(graph.coordinates) || graph.coordinates.length < 2) {
        throw new Error('routing-service devolvió una geometría vacía');
      }

      route = {
        coordinates: graph.coordinates,
        distanceMeters: graph.distanceMeters,
        durationSeconds: graph.durationSeconds,
        durationText: graph.durationText,
        approximate: Boolean(graph.approximate),
        source: 'graph',
      };
    } catch (error) {
      // No es un 500: la ruta recta es una respuesta válida y honesta, con
      // `source: 'straight'` para que la UI lo diga. Se registra para que un
      // servicio dormido se note en los logs y no en silencio.
      console.warn('[routing] respaldo en línea recta:', (error as Error).message);
      route = straightLineRoute(from, to);
    }

    return Response.json(route, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
