import {
  STRATEGY_VERSION,
  assertIncidentTransition,
  type Assignment,
  type DispatchRequest,
  type DispatchResponse,
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
  const run = await q.one<Record<string, unknown>>(
    `SELECT * FROM dispatch_runs WHERE incident_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [incidentId],
  );
  if (!run) throw new DispatchNotFoundError('Corrida de despacho para incidente', incidentId);
  const rows = await q.many<Record<string, unknown>>(`SELECT dc.*, v.callsign
    FROM dispatch_candidates dc JOIN vehicles v ON v.id = dc.vehicle_id
    WHERE dc.dispatch_run_id = ?
    ORDER BY CASE WHEN dc.rank IS NULL THEN 1 ELSE 0 END, dc.rank, v.callsign`, [run.id]);
  const mapped = rows.map((row) => ({
    vehicleId: String(row.vehicle_id), callsign: String(row.callsign), rank: row.rank === null ? null : Number(row.rank),
    etaSeconds: Number(row.eta_seconds ?? 0), distanceM: Number(row.distance_m ?? 0), straightLineM: Number(row.straight_line_m ?? 0),
    etaSource: String(row.eta_source ?? 'HAVERSINE_URBAN') as 'HAVERSINE_URBAN', capabilityPenalty: Number(row.capability_penalty),
    coveragePenalty: Number(row.coverage_penalty), workloadPenalty: Number(row.workload_penalty), staleLocationPenalty: Number(row.stale_location_penalty),
    operationalPenalty: Number(row.operational_penalty), totalScore: Number(row.total_score ?? 0), excludedReason: row.excluded_reason ? String(row.excluded_reason) : null,
    explanation: String(row.explanation ?? ''),
  }));
  const candidates = mapped.filter((candidate) => candidate.excludedReason === null);
  const excluded = mapped.filter((candidate) => candidate.excludedReason !== null);
  return {
    dispatchRunId: String(run.id), incidentId, strategyVersion: String(run.strategy_version), candidates, excluded,
    recommendedVehicleId: run.recommended_vehicle_id ? String(run.recommended_vehicle_id) : null,
    recommendationRationale: run.recommendation_rationale ? String(run.recommendation_rationale) : null,
    assignment: null, durationMs: Number(run.duration_ms ?? 0), computedAt: Number(run.created_at),
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
