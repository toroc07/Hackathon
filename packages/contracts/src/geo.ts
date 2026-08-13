/**
 * CONTRACTS — geometría y modelo de ETA.
 * ⚠ CONGELADO tras W0. OWNER de cambios: A3 (dispatch), vía Athena.
 *
 * Decisión de arquitectura: CERO dependencias externas en runtime.
 * No hay Mapbox Matrix ni Directions. El ETA se calcula localmente y cada
 * término es derivable en vivo frente al jurado. `eta_source` se persiste
 * siempre, para que la UI no mienta sobre de dónde salió el número.
 */

export interface Point {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Distancia en línea recta, metros. */
export function haversineMeters(a: Point, b: Point): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Factor de vía urbana: cuánto más larga es la ruta real que la línea recta.
 * 1.35 es el valor típico de una trama urbana mixta. Cartagena tiene barreras
 * (bahía, ciénaga, centro amurallado) que lo empeoran en cruces específicos,
 * pero un factor global mantiene el modelo explicable y auditable.
 * Calibrable en un solo sitio.
 */
export const ROAD_FACTOR = 1.35;

/**
 * Velocidad de respuesta con prioridad, km/h. No es velocidad de tráfico
 * normal: una ambulancia con sirena atraviesa congestión. Perfil por hora
 * local para que la demo refleje hora pico.
 */
export function emergencySpeedKmh(hourLocal: number): number {
  const isPeak =
    (hourLocal >= 6 && hourLocal <= 9) || (hourLocal >= 17 && hourLocal <= 20);
  const isNight = hourLocal >= 22 || hourLocal <= 5;
  if (isNight) return 55;
  if (isPeak) return 28;
  return 40;
}

export interface EtaResult {
  etaSeconds: number;
  distanceM: number;      // distancia de ruta estimada (ya con ROAD_FACTOR)
  straightLineM: number;  // línea recta cruda, para poder auditar el factor
  speedKmh: number;
  source: 'HAVERSINE_URBAN';
}

/** ETA determinista. Misma entrada → misma salida. Testeable sin red. */
export function estimateEta(from: Point, to: Point, hourLocal: number): EtaResult {
  const straightLineM = haversineMeters(from, to);
  const distanceM = straightLineM * ROAD_FACTOR;
  const speedKmh = emergencySpeedKmh(hourLocal);
  const etaSeconds = Math.round((distanceM / (speedKmh * 1000)) * 3600);
  return { etaSeconds, distanceM: Math.round(distanceM), straightLineM: Math.round(straightLineM), speedKmh, source: 'HAVERSINE_URBAN' };
}

/** Rumbo inicial en grados. Lo usa el simulador para mover el vehículo. */
export function bearingDegrees(from: Point, to: Point): number {
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Avanza `meters` desde `from` hacia `to`. Si se pasa, devuelve `to`. */
export function advanceToward(from: Point, to: Point, meters: number): Point {
  const total = haversineMeters(from, to);
  if (total <= meters || total === 0) return to;
  const f = meters / total;
  return { lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f };
}

/** Bounding box de Cartagena — valida coordenadas y acota el seed. */
export const CARTAGENA_BBOX = {
  minLat: 10.30, maxLat: 10.53,
  minLng: -75.60, maxLng: -75.42,
} as const;

export const CARTAGENA_CENTER: Point = { lat: 10.4056, lng: -75.5144 };

export function isWithinCartagena(p: Point): boolean {
  return (
    p.lat >= CARTAGENA_BBOX.minLat && p.lat <= CARTAGENA_BBOX.maxLat &&
    p.lng >= CARTAGENA_BBOX.minLng && p.lng <= CARTAGENA_BBOX.maxLng
  );
}
