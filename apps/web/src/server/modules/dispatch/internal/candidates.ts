import {
  CAPABILITY_RANK,
  DEFAULT_WEIGHTS,
  estimateEta,
  meetsCapability,
  type CandidateBreakdown,
  type ExclusionReason,
  type ScoringWeights,
} from '@dispatch/contracts';
import { coverageEffect } from './coverage';
import { dispatchDatabase, type DispatchDataAccess } from './data';
import { explainCandidate, explainExclusion, explainRecommendation } from './explain';
import { scoreCandidate } from './scoring';
import type { IncidentRow, VehicleRow, ZoneRow } from './types';
import { getIncidentDetail } from '../../incidents';
import { listVehicles } from '../../vehicles';

export interface CandidateCalculation {
  candidates: CandidateBreakdown[];
  excluded: CandidateBreakdown[];
  recommendationRationale: string | null;
}

function cartagenaHour(timestamp: number): number {
  return (new Date(timestamp).getUTCHours() + 19) % 24;
}

function excludedCandidate(
  vehicle: VehicleRow,
  reason: ExclusionReason,
  explanation: string,
  eta?: ReturnType<typeof estimateEta>,
): CandidateBreakdown {
  return {
    vehicleId: vehicle.id, callsign: vehicle.callsign, rank: null,
    etaSeconds: eta?.etaSeconds ?? 0, distanceM: eta?.distanceM ?? 0,
    straightLineM: eta?.straightLineM ?? 0, etaSource: 'HAVERSINE_URBAN',
    capabilityPenalty: 0, coveragePenalty: 0, workloadPenalty: 0,
    staleLocationPenalty: 0, operationalPenalty: 0, totalScore: eta?.etaSeconds ?? 0,
    excludedReason: reason, explanation,
  };
}

export function loadDispatchInputs(database?: DispatchDataAccess): {
  incident: (id: string) => IncidentRow | undefined;
  vehicles: () => VehicleRow[];
  zones: () => ZoneRow[];
} {
  const db = dispatchDatabase(database);
  return {
    incident: (id) => {
      try {
        const incident = getIncidentDetail(id, db as never).incident;
        return {
          id: incident.id, status: incident.status, lat: incident.lat, lng: incident.lng,
          zone_id: incident.zoneId, required_capability: incident.requiredCapability,
        };
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 404) return undefined;
        throw error;
      }
    },
    vehicles: () => {
      const jobs = new Map((db.prepare(`SELECT assignments.vehicle_id AS vehicle_id, COUNT(*) AS recent_jobs FROM assignments
        JOIN vehicles ON vehicles.id = assignments.vehicle_id
        JOIN shifts ON shifts.id = vehicles.active_shift_id
        WHERE assignments.status = 'COMPLETED'
          AND assignments.completed_at >= shifts.started_at
          AND (shifts.ended_at IS NULL OR assignments.completed_at <= shifts.ended_at)
        GROUP BY assignments.vehicle_id`).all() as Array<{ vehicle_id: string; recent_jobs: number }>)
        .map((row) => [row.vehicle_id, Number(row.recent_jobs)]));
      return listVehicles({}, db as never).map((vehicle) => ({
        id: vehicle.id, callsign: vehicle.callsign, status: vehicle.status,
        capability_level: vehicle.capabilityLevel, operating_zone_id: vehicle.operatingZoneId,
        current_assignment_id: vehicle.currentAssignmentId, lat: vehicle.location?.lat ?? null,
        lng: vehicle.location?.lng ?? null, recorded_at: vehicle.location?.recordedAt ?? null,
        recent_jobs: jobs.get(vehicle.id) ?? 0,
      }));
    },
    zones: () => db.prepare(`
      SELECT z.id, z.name, z.target_coverage_units, z.population_weight,
             COALESCE(SUM(CASE WHEN v.status = 'AVAILABLE' THEN 1 ELSE 0 END), 0) AS available_units
      FROM zones z LEFT JOIN vehicles v ON v.operating_zone_id = z.id
      GROUP BY z.id, z.name, z.target_coverage_units, z.population_weight`).all() as unknown as ZoneRow[],
  };
}

export function calculateCandidates(
  incident: IncidentRow,
  vehicles: readonly VehicleRow[],
  zonesInput: readonly ZoneRow[],
  now: number,
  excludeVehicleIds: readonly string[] = [],
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): CandidateCalculation {
  const zones = new Map(zonesInput.map((zone) => [zone.id, zone]));
  const retryExclusions = new Set(excludeVehicleIds);
  const candidates: CandidateBreakdown[] = [];
  const excluded: CandidateBreakdown[] = [];

  for (const vehicle of vehicles) {
    if (retryExclusions.has(vehicle.id)) {
      excluded.push(excludedCandidate(vehicle, 'ALREADY_ASSIGNED', explainExclusion({ reason: 'ALREADY_ASSIGNED' })));
      continue;
    }
    if (vehicle.status === 'OUT_OF_SERVICE') {
      excluded.push(excludedCandidate(vehicle, 'OUT_OF_SERVICE', explainExclusion({ reason: 'OUT_OF_SERVICE' })));
      continue;
    }
    if (vehicle.status !== 'AVAILABLE') {
      excluded.push(excludedCandidate(vehicle, 'NOT_AVAILABLE', explainExclusion({ reason: 'NOT_AVAILABLE', status: vehicle.status })));
      continue;
    }
    if (!meetsCapability(vehicle.capability_level, incident.required_capability, CAPABILITY_RANK)) {
      const eta = vehicle.lat === null || vehicle.lng === null ? undefined : estimateEta({ lat: vehicle.lat, lng: vehicle.lng }, incident, cartagenaHour(now));
      excluded.push(excludedCandidate(vehicle, 'INSUFFICIENT_CAPABILITY', explainExclusion({ reason: 'INSUFFICIENT_CAPABILITY', vehicleCapability: vehicle.capability_level, requiredCapability: incident.required_capability }), eta));
      continue;
    }
    if (vehicle.lat === null || vehicle.lng === null || vehicle.recorded_at === null) {
      excluded.push(excludedCandidate(vehicle, 'NO_LOCATION', explainExclusion({ reason: 'NO_LOCATION' })));
      continue;
    }
    const locationAgeMs = Math.max(0, now - vehicle.recorded_at);
    const eta = estimateEta({ lat: vehicle.lat, lng: vehicle.lng }, incident, cartagenaHour(now));
    if (locationAgeMs > weights.staleLocationHardCutoffMs) {
      excluded.push(excludedCandidate(vehicle, 'LOCATION_TOO_STALE', explainExclusion({ reason: 'LOCATION_TOO_STALE', locationAgeMs }), eta));
      continue;
    }
    if (eta.etaSeconds > weights.maxEtaSeconds) {
      excluded.push(excludedCandidate(vehicle, 'ETA_TOO_LONG', explainExclusion({ reason: 'ETA_TOO_LONG', etaSeconds: eta.etaSeconds }), eta));
      continue;
    }

    const coverage = coverageEffect(vehicle.operating_zone_id, zones, weights);
    const terms = scoreCandidate({
      etaSeconds: eta.etaSeconds,
      vehicleCapability: vehicle.capability_level,
      requiredCapability: incident.required_capability,
      coverage,
      recentJobs: Number(vehicle.recent_jobs),
      locationAgeMs,
      outsideOperatingZone: Boolean(incident.zone_id && vehicle.operating_zone_id && vehicle.operating_zone_id !== incident.zone_id),
    }, weights);
    const candidate: CandidateBreakdown = {
      vehicleId: vehicle.id, callsign: vehicle.callsign, rank: null,
      etaSeconds: eta.etaSeconds, distanceM: eta.distanceM, straightLineM: eta.straightLineM,
      etaSource: eta.source, ...terms, excludedReason: null, explanation: '',
    };
    candidate.explanation = explainCandidate(candidate, coverage);
    candidates.push(candidate);
  }

  candidates.sort((a, b) => a.totalScore - b.totalScore || a.etaSeconds - b.etaSeconds || a.vehicleId.localeCompare(b.vehicleId));
  candidates.forEach((candidate, index) => { candidate.rank = index + 1; });
  return { candidates, excluded, recommendationRationale: explainRecommendation(candidates) };
}
