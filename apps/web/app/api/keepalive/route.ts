import { db } from '@dispatch/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Despertar Render en frío tarda ~50 s: con el límite por defecto de 10 s la
// función moriría antes de recibir la respuesta y el cron vería un 504.
export const maxDuration = 60;

/**
 * GET /api/keepalive — mantiene despiertas las piezas que se duermen.
 *
 * Las tres dependencias externas de la demo están en capas gratuitas que
 * suspenden por inactividad:
 *
 *   - audio-service (Render): duerme a los ~15 min y tarda ~50 s en despertar.
 *     Ese medio minuto cae justo cuando alguien está reportando una emergencia.
 *   - routing-service: carga 25k nodos del grafo al arrancar; despertarlo en
 *     frío deja el mapa sin ruta durante la primera consulta.
 *   - Neon: suspende el cómputo a los pocos minutos.
 *
 * Un solo GET aquí las toca a todas. Lo llama el cron de GitHub Actions
 * (.github/workflows/keepalive.yml) cada 10 minutos, y también el navegador al
 * abrir la app — si el cron viene retrasado, el primer usuario del día calienta
 * los servicios mientras lee la pantalla, no mientras espera una ambulancia.
 *
 * Nunca falla con 5xx: un monitor que solo mira el código de estado debe ver
 * 200 mientras la app viva. El detalle por servicio va en el cuerpo.
 */

/** Deja margen para responder dentro de los 60 s de `maxDuration`. */
const PING_TIMEOUT_MS = 45_000;

interface ProbeResult {
  ok: boolean;
  ms: number;
  detail?: string;
}

async function probe(name: string, run: () => Promise<void>): Promise<[string, ProbeResult]> {
  const started = Date.now();
  try {
    await run();
    return [name, { ok: true, ms: Date.now() - started }];
  } catch (error) {
    return [name, { ok: false, ms: Date.now() - started, detail: (error as Error).message }];
  }
}

async function ping(baseUrl: string | undefined): Promise<void> {
  if (!baseUrl) throw new Error('sin URL configurada');
  const response = await fetch(new URL('/health', baseUrl), {
    cache: 'no-store',
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export async function GET(): Promise<Response> {
  const results = await Promise.all([
    probe('audio', () => ping(process.env.AUDIO_SERVICE_URL)),
    probe('routing', () => ping(process.env.ROUTING_SERVICE_URL ?? 'http://127.0.0.1:4002')),
    // `SELECT 1` basta para sacar a Neon de la suspensión: el coste está en
    // levantar el cómputo, no en la consulta.
    probe('database', async () => { await db().one('SELECT 1 AS ok'); }),
  ]);

  const services = Object.fromEntries(results) as Record<string, ProbeResult>;

  return Response.json(
    { ok: true, at: new Date().toISOString(), services },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
