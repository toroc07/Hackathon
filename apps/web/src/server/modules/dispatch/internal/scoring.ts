import {
  CAPABILITY_RANK,
  DEFAULT_WEIGHTS,
  totalScore,
  type CapabilityLevel,
  type ScoringWeights,
} from '@dispatch/contracts';
import type { CoverageEffect } from './coverage';

export interface ScoreInput {
  etaSeconds: number;
  vehicleCapability: CapabilityLevel;
  requiredCapability: CapabilityLevel | null;
  coverage: CoverageEffect;
  recentJobs: number;
  locationAgeMs: number;
  outsideOperatingZone: boolean;
}

export interface ScoreTerms {
  capabilityPenalty: number;
  coveragePenalty: number;
  workloadPenalty: number;
  staleLocationPenalty: number;
  operationalPenalty: number;
  totalScore: number;
}

export function scoreCandidate(
  input: ScoreInput,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): ScoreTerms {
  const requiredRank = input.requiredCapability === null ? CAPABILITY_RANK[input.vehicleCapability] : CAPABILITY_RANK[input.requiredCapability];
  const capabilityPenalty = Math.max(0, CAPABILITY_RANK[input.vehicleCapability] - requiredRank)
    * weights.overCapabilitySecondsPerLevel;
  const workloadPenalty = Math.max(0, input.recentJobs) * weights.workloadSecondsPerRecentJob;
  const staleLocationPenalty = Math.min(
    weights.staleLocationMaxSeconds,
    Math.floor(Math.max(0, input.locationAgeMs) / 30_000) * weights.staleLocationSecondsPer30s,
  );
  const operationalPenalty = input.outsideOperatingZone ? weights.outOfZoneSeconds : 0;
  const terms = {
    capabilityPenalty,
    coveragePenalty: input.coverage.penalty,
    workloadPenalty,
    staleLocationPenalty,
    operationalPenalty,
  };
  return { ...terms, totalScore: totalScore({ etaSeconds: input.etaSeconds, ...terms }) };
}
