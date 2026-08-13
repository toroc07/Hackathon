import type { ScoringWeights } from '@dispatch/contracts';
import type { ZoneRow } from './types';

export interface CoverageEffect {
  penalty: number;
  deficitBefore: number;
  deficitAfter: number;
  isLastAvailableUnit: boolean;
  zoneName: string | null;
}

export function coverageEffect(
  operatingZoneId: string | null,
  zones: ReadonlyMap<string, ZoneRow>,
  weights: ScoringWeights,
): CoverageEffect {
  const zone = operatingZoneId ? zones.get(operatingZoneId) : undefined;
  if (!zone) {
    return { penalty: 0, deficitBefore: 0, deficitAfter: 0, isLastAvailableUnit: false, zoneName: null };
  }

  const deficitBefore = Math.max(0, zone.target_coverage_units - zone.available_units);
  const deficitAfter = Math.max(0, zone.target_coverage_units - Math.max(0, zone.available_units - 1));
  return {
    penalty: (deficitAfter - deficitBefore) * weights.coverageSecondsPerDeficitUnit * zone.population_weight,
    deficitBefore,
    deficitAfter,
    isLastAvailableUnit: zone.available_units === 1,
    zoneName: zone.name,
  };
}
