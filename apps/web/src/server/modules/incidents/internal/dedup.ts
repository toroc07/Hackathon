import { haversineMeters, type Incident, type IncidentType, type Point } from '@dispatch/contracts';

export const AUTO_MERGE_BASE_METERS = 150;
export const AUTO_MERGE_WINDOW_MS = 5 * 60_000;
export const SUGGEST_MERGE_METERS = 400;
export const SUGGEST_MERGE_WINDOW_MS = 10 * 60_000;
export const LIVE_LOOKBACK_MS = 15 * 60_000;

export const MAX_AUTO_MERGE_ACCURACY_M = 100;

export const TYPE_COMPATIBILITY: Record<IncidentType, readonly IncidentType[]> = {
  TRAFFIC_ACCIDENT: ['TRAFFIC_ACCIDENT', 'TRAUMA'],
  TRAUMA: ['TRAUMA', 'TRAFFIC_ACCIDENT', 'FALL'],
  FALL: ['FALL', 'TRAUMA'],
  CARDIAC: ['CARDIAC', 'UNCONSCIOUS'],
  UNCONSCIOUS: ['UNCONSCIOUS', 'CARDIAC'],
  RESPIRATORY: ['RESPIRATORY'],
  OBSTETRIC: ['OBSTETRIC'],
  OTHER: ['OTHER'],
};

export function areIncidentTypesCompatible(a: IncidentType, b: IncidentType): boolean {
  return TYPE_COMPATIBILITY[a].includes(b) && TYPE_COMPATIBILITY[b].includes(a);
}

export type DedupDecision =
  | { kind: 'MERGE'; incident: Incident; distanceM: number; deltaMs: number; confidence: number; reason: string }
  | { kind: 'SUGGEST'; incident: Incident; distanceM: number; deltaMs: number; confidence: number; reason: string }
  | { kind: 'NEW' };

interface DedupInput {
  type: IncidentType;
  point: Point;
  accuracyM?: number | null;
  createdAt: number;
}

interface Candidate {
  incident: Incident;
  distanceM: number;
  deltaMs: number;
}

function confidence(distanceM: number, deltaMs: number, maxDistance: number, maxTime: number): number {
  const distanceScore = Math.max(0, 1 - distanceM / maxDistance);
  const timeScore = Math.max(0, 1 - deltaMs / maxTime);
  return Number((0.6 + 0.25 * distanceScore + 0.15 * timeScore).toFixed(2));
}

export function decideDeduplication(input: DedupInput, incidents: readonly Incident[]): DedupDecision {
  const accuracyM = Math.max(0, input.accuracyM ?? 0);
  const effectiveThreshold = AUTO_MERGE_BASE_METERS + accuracyM;
  const candidates: Candidate[] = incidents
    .map((incident) => ({
      incident,
      distanceM: haversineMeters(input.point, { lat: incident.lat, lng: incident.lng }),
      deltaMs: Math.abs(input.createdAt - incident.createdAt),
    }))
    .sort((a, b) => a.distanceM - b.distanceM || a.deltaMs - b.deltaMs);

  // Una lectura demasiado imprecisa puede ampliar la búsqueda, pero no es
  // evidencia suficiente para fusionar sin revisión humana.
  const automatic = accuracyM <= MAX_AUTO_MERGE_ACCURACY_M && candidates.find(({ incident, distanceM, deltaMs }) =>
    distanceM <= effectiveThreshold &&
    deltaMs <= AUTO_MERGE_WINDOW_MS &&
    areIncidentTypesCompatible(input.type, incident.type),
  );
  if (automatic) {
    const reason = `Merge automático: ${Math.round(automatic.distanceM)}m, ${Math.round(automatic.deltaMs / 1000)}s, tipos compatibles; umbral ${Math.round(effectiveThreshold)}m`;
    return {
      kind: 'MERGE', ...automatic,
      confidence: confidence(automatic.distanceM, automatic.deltaMs, effectiveThreshold, AUTO_MERGE_WINDOW_MS),
      reason,
    };
  }

  const gray = candidates.find(({ distanceM, deltaMs }) =>
    distanceM <= SUGGEST_MERGE_METERS && deltaMs <= SUGGEST_MERGE_WINDOW_MS,
  );
  if (gray) {
    const compatible = areIncidentTypesCompatible(input.type, gray.incident.type);
    return {
      kind: 'SUGGEST', ...gray,
      confidence: confidence(gray.distanceM, gray.deltaMs, SUGGEST_MERGE_METERS, SUGGEST_MERGE_WINDOW_MS),
      reason: `Posible duplicado: ${Math.round(gray.distanceM)}m, ${Math.round(gray.deltaMs / 1000)}s, tipos ${compatible ? 'compatibles' : 'incompatibles'}${accuracyM > MAX_AUTO_MERGE_ACCURACY_M ? `, GPS ±${Math.round(accuracyM)}m` : ''}; requiere revisión humana`,
    };
  }

  return { kind: 'NEW' };
}
