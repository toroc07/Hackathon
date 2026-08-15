import { estimateEta, type Point } from '@dispatch/contracts';

/**
 * Contrato de la ruta que dibuja el mapa.
 *
 * `source` viaja hasta la UI a propósito: el mapa dice "por calles" o
 * "estimada" según de dónde salió la geometría. Un trazo recto presentado
 * como ruta real haría que el conductor confíe en un ETA que no existe.
 */
export interface RouteResult {
  /** [lng, lat] — mismo orden que GeoJSON, que es lo que consume MapLibre. */
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  durationText: string;
  /** `graph` = A* sobre el grafo vial; `straight` = respaldo en línea recta. */
  source: 'graph' | 'straight';
  /** El punto quedó lejos de cualquier vía mapeada: la ruta es aproximada. */
  approximate: boolean;
}

/** Hora local de Cartagena (UTC-5, sin horario de verano). */
export function cartagenaHour(date = new Date()): number {
  return (date.getUTCHours() + 19) % 24;
}

/**
 * Respaldo cuando el servicio del grafo no responde: línea recta con el mismo
 * modelo de ETA que ya usa el despacho (`estimateEta`), para que el número del
 * mapa y el del motor de asignación no se contradigan delante del usuario.
 */
export function straightLineRoute(from: Point, to: Point): RouteResult {
  const eta = estimateEta(from, to, cartagenaHour());
  const minutes = Math.max(1, Math.round(eta.etaSeconds / 60));
  return {
    coordinates: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
    distanceMeters: eta.distanceM,
    durationSeconds: eta.etaSeconds,
    durationText: `${minutes} min`,
    source: 'straight',
    approximate: true,
  };
}

/** Longitud acumulada de la polilínea, en metros, tramo a tramo. */
export function cumulativeDistances(coordinates: [number, number][]): number[] {
  const totals = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    const [aLng, aLat] = coordinates[i - 1];
    const [bLng, bLat] = coordinates[i];
    totals.push(totals[i - 1] + metersBetween(aLat, aLng, bLat, bLng));
  }
  return totals;
}

/**
 * Punto a `meters` del inicio de la polilínea, interpolando dentro del tramo.
 * Es lo que permite que la ambulancia se deslice por la calle en vez de saltar
 * de vértice en vértice.
 */
export function pointAtDistance(
  coordinates: [number, number][],
  totals: number[],
  meters: number,
): { lng: number; lat: number; bearing: number } {
  if (coordinates.length === 0) return { lng: 0, lat: 0, bearing: 0 };
  if (coordinates.length === 1) {
    return { lng: coordinates[0][0], lat: coordinates[0][1], bearing: 0 };
  }

  const total = totals[totals.length - 1];
  const target = Math.max(0, Math.min(meters, total));

  let index = 1;
  while (index < totals.length - 1 && totals[index] < target) index += 1;

  const segmentStart = totals[index - 1];
  const segmentLength = totals[index] - segmentStart || 1;
  const ratio = (target - segmentStart) / segmentLength;

  const [aLng, aLat] = coordinates[index - 1];
  const [bLng, bLat] = coordinates[index];

  return {
    lng: aLng + (bLng - aLng) * ratio,
    lat: aLat + (bLat - aLat) * ratio,
    bearing: bearingBetween(aLat, aLng, bLat, bLng),
  };
}

/**
 * Distancia recorrida sobre la ruta que corresponde al punto más cercano a
 * `point`. Es lo que convierte una posición GPS suelta en "va por el kilómetro
 * 1,8 de esta ruta", y con eso el mapa puede atenuar el tramo ya recorrido y
 * mover el icono por la calle en vez de en línea recta.
 */
export function progressAt(
  coordinates: [number, number][],
  totals: number[],
  point: Point,
): number {
  let best = 0;
  let bestDistance = Infinity;

  for (let i = 1; i < coordinates.length; i += 1) {
    const [aLng, aLat] = coordinates[i - 1];
    const [bLng, bLat] = coordinates[i];

    // Proyección en el plano lat/lng corrigiendo la longitud por el coseno de
    // la latitud. A escala de ciudad el error es de centímetros.
    const cos = Math.cos(toRad(aLat));
    const ax = aLng * cos;
    const bx = bLng * cos;
    const px = point.lng * cos;

    const dx = bx - ax;
    const dy = bLat - aLat;
    const lengthSquared = dx * dx + dy * dy;

    const t = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (point.lat - aLat) * dy) / lengthSquared));

    const projLng = aLng + (bLng - aLng) * t;
    const projLat = aLat + (bLat - aLat) * t;
    const distance = metersBetween(point.lat, point.lng, projLat, projLng);

    if (distance < bestDistance) {
      bestDistance = distance;
      best = totals[i - 1] + (totals[i] - totals[i - 1]) * t;
    }
  }

  return best;
}

/** Distancia en metros entre dos puntos. Reexporta el haversine local para que
 *  el mapa no tenga que importar los contratos solo para esto. */
export function distanceMeters(a: Point, b: Point): number {
  return metersBetween(a.lat, a.lng, b.lat, b.lng);
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function bearingBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
