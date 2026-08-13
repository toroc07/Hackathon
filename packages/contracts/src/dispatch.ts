/**
 * CONTRACTS — modelo de scoring del motor de despacho.
 * ⚠ CONGELADO tras W0. OWNER: A3. A4 lo CONSUME para renderizar; no lo recalcula.
 *
 * PRINCIPIO (§9): el score se expresa en SEGUNDOS-EQUIVALENTES.
 * Cada penalización responde a "¿cuántos segundos de ETA extra estoy dispuesto
 * a aceptar para evitar esto?". Eso hace que la explicación sea una frase en
 * español, no una fórmula con pesos arbitrarios:
 *
 *   "A16 llega 31s antes, pero dejaría Crespo sin cobertura durante 12 min.
 *    Eso vale 120s. Por eso recomendamos A12."
 *
 * MENOR score = MEJOR candidato.
 */

import type { CapabilityLevel, EtaSource } from './enums.js';

export const STRATEGY_VERSION = 'v1';

export interface ScoringWeights {
  /** Segundos añadidos por cada nivel de capacidad POR ENCIMA del requerido.
   *  Mandar una ALS a una caída no es un error, pero desperdicia el recurso caro. */
  overCapabilitySecondsPerLevel: number;

  /** Segundos por cada unidad de déficit de cobertura que dejaría esta asignación.
   *  El término que hace que el sistema piense en la ciudad, no solo en el incidente. */
  coverageSecondsPerDeficitUnit: number;

  /** Segundos por cada servicio ya completado por esta tripulación en el turno.
   *  Reparte la carga y evita quemar a una tripulación. */
  workloadSecondsPerRecentJob: number;

  /** Segundos por cada 30s de antigüedad del GPS, tope incluido.
   *  Un vehículo cuya posición es de hace 5 min podría no estar donde creemos. */
  staleLocationSecondsPer30s: number;
  staleLocationMaxSeconds: number;
  /** Más allá de esto el vehículo se EXCLUYE, no se penaliza. */
  staleLocationHardCutoffMs: number;

  /** Segundos por operar fuera de su zona asignada. Blando: cruzar zona se
   *  permite si el ETA lo justifica; solo deja de ser gratis. */
  outOfZoneSeconds: number;

  /** Ventana de vida de una oferta antes de expirar y re-despachar. */
  offerTimeoutMs: number;

  /** Techo de ETA: más allá de esto no es un candidato razonable. */
  maxEtaSeconds: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  overCapabilitySecondsPerLevel: 45,
  coverageSecondsPerDeficitUnit: 120,
  workloadSecondsPerRecentJob: 30,
  staleLocationSecondsPer30s: 20,
  staleLocationMaxSeconds: 180,
  staleLocationHardCutoffMs: 5 * 60 * 1000,
  outOfZoneSeconds: 60,
  offerTimeoutMs: 30 * 1000,
  maxEtaSeconds: 20 * 60,
};

/** Razones de EXCLUSIÓN. Un excluido nunca es candidato, por bueno que sea su ETA. */
export const EXCLUSION_REASON = [
  'NOT_AVAILABLE',          // status ≠ AVAILABLE
  'INSUFFICIENT_CAPABILITY',// por debajo de lo que exige el incidente
  'NO_LOCATION',            // nunca reportó GPS
  'LOCATION_TOO_STALE',     // GPS más viejo que el corte duro
  'ETA_TOO_LONG',
  'OUT_OF_SERVICE',
  'ALREADY_ASSIGNED',       // ganó otra carrera entre el cálculo y la asignación
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASON)[number];

/** Desglose persistido en dispatch_candidates. Lo que la UI pinta tal cual. */
export interface CandidateBreakdown {
  vehicleId: string;
  callsign: string;
  rank: number | null;

  etaSeconds: number;
  distanceM: number;
  straightLineM: number;
  etaSource: EtaSource;

  capabilityPenalty: number;
  coveragePenalty: number;
  workloadPenalty: number;
  staleLocationPenalty: number;
  operationalPenalty: number;

  totalScore: number;
  excludedReason: ExclusionReason | null;

  /** Frase lista para pantalla, generada por REGLA, no por LLM (§24, §25). */
  explanation: string;
}

export interface DispatchResult {
  dispatchRunId: string;
  incidentId: string;
  strategyVersion: string;
  candidates: CandidateBreakdown[];   // ordenados, mejor primero
  excluded: CandidateBreakdown[];
  recommendedVehicleId: string | null;
  /** Por qué el #1 le ganó al #2. El corazón de la demo. */
  recommendationRationale: string | null;
  durationMs: number;
  computedAt: number;
}

/**
 * Suma canónica. Vive en contracts para que A3 y los tests usen exactamente
 * la misma aritmética y A4 pueda verificar que lo que pinta cuadra.
 */
export function totalScore(c: {
  etaSeconds: number;
  capabilityPenalty: number;
  coveragePenalty: number;
  workloadPenalty: number;
  staleLocationPenalty: number;
  operationalPenalty: number;
}): number {
  return (
    c.etaSeconds +
    c.capabilityPenalty +
    c.coveragePenalty +
    c.workloadPenalty +
    c.staleLocationPenalty +
    c.operationalPenalty
  );
}

export function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}

/** Capacidad suficiente = rango del vehículo ≥ rango requerido. */
export function meetsCapability(
  vehicleLevel: CapabilityLevel,
  required: CapabilityLevel | null,
  rank: Record<CapabilityLevel, number>,
): boolean {
  if (!required) return true;
  return rank[vehicleLevel] >= rank[required];
}
