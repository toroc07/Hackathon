import {
  STRATEGY_VERSION,
  assertIncidentTransition,
  type Assignment,
  type CandidateBreakdown,
  type DispatchRequest,
  type DispatchResponse,
  type EtaSource,
  type ExclusionReason,
  type RejectReason,
} from '@dispatch/contracts';
import { db, newId, tx, type Queryable } from '@/src/server/infra/db';
import { calculateCandidates, loadDispatchInputs } from './candidates';
import {
  acceptOffer, completeOffer, createAtomicAssignment, DispatchNotFoundError,
  markOfferArrived, markOfferEnRoute, rejectOffer, startOfferTransport,
  VehicleUnavailableError, type AssignVehicleInput,
} from './assignment';

export interface DispatchOptions {
  q?: Queryable;
  now?: number;
  triggeredBy?: 'AUTO' | 'DISPATCHER' | 'RETRY' | 'TIMEOUT';
  triggeredByUserId?: string | null;
  idempotencyKey?: string | null;
}

interface DispatchRunRow extends Record<string, unknown> {
  id: string;
  strategy_version: string;
  recommended_vehicle_id: string | null;
  recommendation_rationale: string | null;
  duration_ms: number;
  created_at: number;
}

interface CandidateRow extends Record<string, unknown> {
  vehicle_id: string;
  callsign: string;
  rank: number | null;
  eta_seconds: number;
  distance_m: number;
  straight_line_m: number;
  eta_source: EtaSource;
  capability_penalty: number;
  coverage_penalty: number;
  workload_penalty: number;
  stale_location_penalty: number;
  operational_penalty: number;
  total_score: number;
  excluded_reason: ExclusionReason | null;
  explanation: string;
}

async function persistRun(
  q: Queryable | undefined,
  runId: string,
  incidentId: string,
  result: ReturnType<typeof calculateCandidates>,
  options: Required<Pick<DispatchOptions, 'now' | 'triggeredBy'>> & DispatchOptions,
  durationMs: number,
): Promise<void> {
  const operation = async (t: Queryable): Promise<void> => {
    await t.run(`INSERT INTO dispatch_runs
      (id, incident_id, triggered_by, triggered_by_user_id, strategy_version,
       candidates_count, excluded_count, recommended_vehicle_id, recommendation_rationale,
       duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      runId, incidentId, options.triggeredBy, options.triggeredByUserId ?? null,
      STRATEGY_VERSION, result.candidates.length, result.excluded.length,
      result.candidates[0]?.vehicleId ?? null, result.recommendationRationale, durationMs, options.now,
    ]);
    for (const candidate of [...result.candidates, ...result.excluded]) {
      await t.run(`INSERT INTO dispatch_candidates
        (id, dispatch_run_id, vehicle_id, rank, eta_seconds, distance_m, straight_line_m,
         eta_source, capability_penalty, coverage_penalty, workload_penalty,
         stale_location_penalty, operational_penalty, total_score, excluded_reason, explanation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        newId(options.now), runId, candidate.vehicleId, candidate.rank,
        candidate.etaSeconds, candidate.distanceM, candidate.straightLineM, candidate.etaSource,
        candidate.capabilityPenalty, candidate.coveragePenalty, candidate.workloadPenalty,
        candidate.staleLocationPenalty, candidate.operationalPenalty, candidate.totalScore,
        candidate.excludedReason, candidate.explanation,
      ]);
    }
    await t.run(`INSERT INTO incident_events
      (id, incident_id, event_type, actor_type, actor_id, metadata, created_at)
      VALUES (?, ?, 'DISPATCH_STARTED', 'SYSTEM', ?, ?, ?)`, [
      newId(options.now), incidentId, options.triggeredByUserId ?? null,
      JSON.stringify({ dispatchRunId: runId }), options.now,
    ]);
    await t.run(`INSERT INTO incident_events
      (id, incident_id, event_type, actor_type, actor_id, metadata, created_at)
      VALUES (?, ?, 'CANDIDATES_CALCULATED', 'SYSTEM', NULL, ?, ?)`, [
      newId(options.now), incidentId,
      JSON.stringify({ candidates: result.candidates.length, excluded: result.excluded.length }), options.now,
    ]);
    if (result.candidates[0]) {
      await t.run(`INSERT INTO incident_events
        (id, incident_id, event_type, actor_type, actor_id, metadata, created_at)
        VALUES (?, ?, 'VEHICLE_RECOMMENDED', 'SYSTEM', NULL, ?, ?)`, [
        newId(options.now), incidentId,
        JSON.stringify({ vehicleId: result.candidates[0].vehicleId, score: result.candidates[0].totalScore }),
        options.now,
      ]);
    }
  };
  await (q ? operation(q) : tx(operation));
}

export async function executeDispatch(
  incidentId: string,
  request: DispatchRequest,
  options: DispatchOptions = {},
): Promise<DispatchResponse> {
  const q = options.q ?? db();
  const now = options.now ?? Date.now();
  const started = performance.now();
  const input = loadDispatchInputs(q);
  const incident = await input.incident(incidentId);
  if (!incident) throw new DispatchNotFoundError('Incidente', incidentId);
  if (incident.status === 'NO_RESOURCE') {
    assertIncidentTransition('NO_RESOURCE', 'OPEN');
    await q.run(`UPDATE incidents SET status = 'OPEN' WHERE id = ?`, [incidentId]);
    incident.status = 'OPEN';
  }
  if (incident.status !== 'OPEN') assertIncidentTransition(incident.status, 'ASSIGNING');

  const [vehicles, zones] = await Promise.all([input.vehicles(), input.zones()]);
  const calculated = calculateCandidates(incident, vehicles, zones, now, request.excludeVehicleIds ?? []);
  const override = request.overrideVehicleId
    ? calculated.candidates.find((candidate) => candidate.vehicleId === request.overrideVehicleId)
    : undefined;
  if (request.overrideVehicleId && !override) throw new VehicleUnavailableError(request.overrideVehicleId);
  const chosen = override ?? calculated.candidates[0];
  const runId = newId(now);
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  await persistRun(options.q, runId, incidentId, calculated, {
    ...options, now, triggeredBy: options.triggeredBy ?? 'DISPATCHER',
  }, durationMs);

  let assignment: Assignment | null = null;
  if (!chosen) {
    assertIncidentTransition(incident.status, 'NO_RESOURCE');
    const operation = async (t: Queryable): Promise<void> => {
      await t.run(`UPDATE incidents SET status = 'NO_RESOURCE' WHERE id = ?`, [incidentId]);
      await t.run(`INSERT INTO incident_events
        (id, incident_id, event_type, actor_type, actor_id, metadata, created_at)
        VALUES (?, ?, 'NO_RESOURCE_AVAILABLE', 'SYSTEM', NULL, ?, ?)`, [
        newId(now), incidentId, JSON.stringify({ dispatchRunId: runId }), now,
      ]);
    };
    await (options.q ? operation(options.q) : tx(operation));
  } else if (request.mode === 'AUTO_ASSIGN' || request.overrideVehicleId) {
    assignment = await createAtomicAssignment({
      incidentId, vehicleId: chosen.vehicleId, dispatchRunId: runId,
      idempotencyKey: options.idempotencyKey, isManualOverride: Boolean(request.overrideVehicleId),
      assignedByUserId: options.triggeredByUserId, now, q: options.q,
    });
  }

  return {
    dispatchRunId: runId, incidentId, strategyVersion: STRATEGY_VERSION,
    candidates: calculated.candidates, excluded: calculated.excluded,
    recommendedVehicleId: chosen?.vehicleId ?? null,
    recommendationRationale: calculated.recommendationRationale,
    assignment, durationMs, computedAt: now,
  };
}

export async function getPersistedCandidates(
  incidentId: string,
  q: Queryable = db(),
): Promise<DispatchResponse> {
  const run = await q.one<DispatchRunRow>(
    `SELECT * FROM dispatch_runs WHERE incident_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [incidentId],
  );
  if (!run) throw new DispatchNotFoundError('Corrida de despacho para incidente', incidentId);
  const rows = await q.many<CandidateRow>(`SELECT dc.*, v.callsign
    FROM dispatch_candidates dc JOIN vehicles v ON v.id = dc.vehicle_id
    WHERE dc.dispatch_run_id = ?
    ORDER BY CASE WHEN dc.rank IS NULL THEN 1 ELSE 0 END, dc.rank, v.callsign`, [run.id]);
  const mapped: CandidateBreakdown[] = rows.map((row) => ({
    vehicleId: row.vehicle_id, callsign: row.callsign, rank: row.rank,
    etaSeconds: row.eta_seconds, distanceM: row.distance_m, straightLineM: row.straight_line_m,
    etaSource: row.eta_source, capabilityPenalty: row.capability_penalty,
    coveragePenalty: row.coverage_penalty, workloadPenalty: row.workload_penalty,
    staleLocationPenalty: row.stale_location_penalty, operationalPenalty: row.operational_penalty,
    totalScore: row.total_score, excludedReason: row.excluded_reason, explanation: row.explanation,
  }));
  const candidates = mapped.filter((candidate) => candidate.excludedReason === null);
  const excluded = mapped.filter((candidate) => candidate.excludedReason !== null);
  return {
    dispatchRunId: run.id, incidentId, strategyVersion: run.strategy_version, candidates, excluded,
    recommendedVehicleId: run.recommended_vehicle_id,
    recommendationRationale: run.recommendation_rationale,
    assignment: null, durationMs: run.duration_ms, computedAt: run.created_at,
  };
}

export const assign = (input: AssignVehicleInput) => createAtomicAssignment(input);
export const accept = acceptOffer;
export const enRoute = markOfferEnRoute;
export const arrive = markOfferArrived;
export const transport = startOfferTransport;
export const complete = completeOffer;

export async function rejectAndRedispatch(id: string, reason: RejectReason, options: DispatchOptions = {}) {
  const assignment = await rejectOffer(id, reason, options);
  const dispatch = await executeDispatch(
    assignment.incidentId,
    { mode: 'AUTO_ASSIGN', excludeVehicleIds: [assignment.vehicleId] },
    { ...options, triggeredBy: 'RETRY' },
  );
  return { assignment, dispatch };
}
