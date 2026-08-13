import { formatSeconds, type CandidateBreakdown, type CapabilityLevel, type ExclusionReason } from '@dispatch/contracts';
import type { CoverageEffect } from './coverage';

const STATUS_LABEL: Record<string, string> = {
  OFFLINE: 'fuera de turno', RESERVED: 'con una oferta activa', ASSIGNED: 'asignada',
  EN_ROUTE: 'en ruta a otro incidente', ON_SCENE: 'atendiendo en escena',
  TRANSPORTING: 'transportando un paciente', UNAVAILABLE: 'no disponible',
  OUT_OF_SERVICE: 'fuera de servicio',
};

export interface ExclusionContext {
  reason: ExclusionReason;
  status?: string;
  vehicleCapability?: CapabilityLevel;
  requiredCapability?: CapabilityLevel | null;
  locationAgeMs?: number;
  etaSeconds?: number;
}

export function explainExclusion(context: ExclusionContext): string {
  switch (context.reason) {
    case 'OUT_OF_SERVICE': return 'Unidad fuera de servicio';
    case 'NOT_AVAILABLE': return `Unidad ${STATUS_LABEL[context.status ?? ''] ?? 'no disponible'}`;
    case 'INSUFFICIENT_CAPABILITY': return `${context.vehicleCapability ?? 'La unidad'} no cubre el requisito ${context.requiredCapability ?? 'del incidente'}`;
    case 'NO_LOCATION': return 'Sin posición GPS actual';
    case 'LOCATION_TOO_STALE': return `Última posición GPS hace ${Math.floor((context.locationAgeMs ?? 0) / 60_000)} min (corte: 5 min)`;
    case 'ETA_TOO_LONG': return `ETA ${formatSeconds(context.etaSeconds ?? 0)} supera el máximo de 20m00s`;
    case 'ALREADY_ASSIGNED': return 'Excluida de este reintento por rechazo, expiración o asignación previa';
  }
}

export function explainCandidate(candidate: CandidateBreakdown, coverage: CoverageEffect): string {
  const terms: string[] = [`ETA ${formatSeconds(candidate.etaSeconds)}`];
  if (candidate.capabilityPenalty) terms.push(`capacidad ${formatSeconds(candidate.capabilityPenalty)}`);
  if (candidate.coveragePenalty) terms.push(`cobertura ${formatSeconds(candidate.coveragePenalty)}`);
  if (candidate.workloadPenalty) terms.push(`carga ${formatSeconds(candidate.workloadPenalty)}`);
  if (candidate.staleLocationPenalty) terms.push(`GPS ${formatSeconds(candidate.staleLocationPenalty)}`);
  if (candidate.operationalPenalty) terms.push(`fuera de zona ${formatSeconds(candidate.operationalPenalty)}`);
  const coverageDetail = coverage.isLastAvailableUnit && coverage.zoneName
    ? ` — es la última unidad libre en ${coverage.zoneName}`
    : '';
  return `${terms.join(' + ')} = ${formatSeconds(candidate.totalScore)}${coverageDetail}`;
}

export function explainRecommendation(candidates: readonly CandidateBreakdown[]): string | null {
  const winner = candidates[0];
  const runnerUp = candidates[1];
  if (!winner) return null;
  if (!runnerUp) return `${winner.callsign} es la única unidad viable; score ${formatSeconds(winner.totalScore)}.`;

  if (runnerUp.etaSeconds < winner.etaSeconds && runnerUp.coveragePenalty > winner.coveragePenalty) {
    const etaAdvantage = winner.etaSeconds - runnerUp.etaSeconds;
    const coverageDifference = runnerUp.coveragePenalty - winner.coveragePenalty;
    return `${runnerUp.callsign} llega ${formatSeconds(etaAdvantage)} antes, pero su impacto de cobertura cuesta ${formatSeconds(coverageDifference)} más. Por eso se recomienda ${winner.callsign}.`;
  }
  return `${winner.callsign} obtiene ${formatSeconds(runnerUp.totalScore - winner.totalScore)} de ventaja en el score total frente a ${runnerUp.callsign}. Por eso se recomienda ${winner.callsign}.`;
}
