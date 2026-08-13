import {
  assertIncidentTransition,
  type ActorType,
  type CreateIncidentRequest,
  type CreateIncidentResponse,
  type Incident,
  type IncidentDetailResponse,
  type IncidentEvent,
  type IncidentPriority,
  type IncidentStatus,
  type TriageResult,
  type zUpdateIncidentRequest,
} from '@dispatch/contracts';
import type { z } from 'zod';
import { bus } from '@/src/server/infra/bus';
import { db, newId, tx, type Queryable } from '@/src/server/infra/db';
import { HttpError } from '@/src/server/infra/errors';
import { decideDeduplication, LIVE_LOOKBACK_MS } from './internal/dedup';
import { appendIncidentEvent, type AppendEventInput } from './internal/events';
import {
  findIncident,
  findIncidentForReport,
  findReportByIdempotencyKey,
  insertIncident,
  insertReport,
  listEvents,
  listLive,
  listRecentLiveIncidents,
  listReports,
  readAssignmentContext,
  setIncidentStatus,
  setPrimaryReport,
  setTriage,
  updateOperationalFields,
} from './internal/repository';
import { applyTriage } from './internal/triage';

export type UpdateIncidentRequest = z.infer<typeof zUpdateIncidentRequest>;

export interface IncidentEngineOptions {
  now?: number;
  actorType?: ActorType;
  actorId?: string | null;
  idempotencyKey?: string | null;
}

const PRIORITY_RANK: Record<IncidentPriority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };
const CAPABILITY_RANK: Record<NonNullable<Incident['requiredCapability']>, number> = {
  MEDICAL_MOTO: 0,
  BLS: 1,
  ALS: 2,
  RESCUE: 3,
};

async function requireIncident(q: Queryable, incidentId: string): Promise<Incident> {
  const incident = await findIncident(q, incidentId);
  if (!incident) throw new HttpError(404, 'NOT_FOUND', 'Incidente no encontrado');
  return incident;
}

async function transitionIncident(
  q: Queryable,
  incident: Incident,
  next: IncidentStatus,
  closedAt: number | null = null,
): Promise<Incident> {
  assertIncidentTransition(incident.status, next);
  await setIncidentStatus(q, incident.id, next, closedAt);
  return { ...incident, status: next, closedAt };
}

function incidentCode(id: string): string {
  return `INC-${id.slice(-3)}`;
}

async function idempotentResult(q: Queryable, key?: string | null): Promise<CreateIncidentResponse | null> {
  if (!key) return null;
  const report = await findReportByIdempotencyKey(q, key);
  if (!report) return null;
  const incident = await findIncidentForReport(q, report);
  if (!incident) throw new Error('Reporte idempotente sin incidente asociado');
  return {
    incident,
    report,
    wasMerged: report.wasMerged,
    mergedIntoIncidentId: report.wasMerged ? incident.id : null,
  };
}

function signalsFor(request: CreateIncidentRequest) {
  return { patientCount: request.patientCount, ...(request.signals ?? {}) };
}

function shouldEscalate(current: Incident, result: TriageResult): boolean {
  if (!current.priority || !current.requiredCapability) return true;
  return PRIORITY_RANK[result.priority] < PRIORITY_RANK[current.priority]
    || CAPABILITY_RANK[result.requiredCapability] > CAPABILITY_RANK[current.requiredCapability];
}

export async function createIncidentFromReport(
  request: CreateIncidentRequest,
  options: IncidentEngineOptions = {},
): Promise<CreateIncidentResponse> {
  const now = options.now ?? Date.now();
  const actorType = options.actorType ?? 'REPORTER';
  let emittedTopic: 'incident:created' | 'incident:merged' | null = null;
  const result = await tx(async (t) => {
    const previous = await idempotentResult(t, options.idempotencyKey);
    if (previous) return previous;

    const triageResult = applyTriage(request.type, signalsFor(request));
    const decision = decideDeduplication(
      { type: request.type, point: request.point, accuracyM: request.accuracyM, createdAt: now },
      await listRecentLiveIncidents(t, now - LIVE_LOOKBACK_MS),
    );

    if (decision.kind === 'MERGE') {
      const report = {
        id: newId(now), incidentId: decision.incident.id, source: request.source,
        reporterContact: request.reporterContact ?? null,
        description: request.description ?? null,
        lat: request.point.lat, lng: request.point.lng, accuracyM: request.accuracyM ?? null,
        wasMerged: true, mergeConfidence: decision.confidence,
        mergeReason: decision.reason, createdAt: now,
      };
      await insertReport(t, report, options.idempotencyKey ?? undefined);
      await appendIncidentEvent(t, {
        incidentId: decision.incident.id, eventType: 'REPORT_MERGED', actorType,
        actorId: options.actorId, createdAt: now,
        metadata: { reportId: report.id, confidence: decision.confidence, reason: decision.reason },
      });
      if (shouldEscalate(decision.incident, triageResult)) {
        const priority = !decision.incident.priority
          || PRIORITY_RANK[triageResult.priority] < PRIORITY_RANK[decision.incident.priority]
          ? triageResult.priority : decision.incident.priority;
        const capability = !decision.incident.requiredCapability
          || CAPABILITY_RANK[triageResult.requiredCapability] > CAPABILITY_RANK[decision.incident.requiredCapability]
          ? triageResult.requiredCapability : decision.incident.requiredCapability;
        await setTriage(t, decision.incident.id, priority, capability);
        await appendIncidentEvent(t, {
          incidentId: decision.incident.id, eventType: 'PRIORITY_SET', actorType: 'SYSTEM', createdAt: now,
          metadata: { priority, requiredCapability: capability, ruleId: triageResult.ruleId, escalatedByReportId: report.id },
        });
      }
      if (request.patientCount > decision.incident.patientCount) {
        await updateOperationalFields(t, decision.incident.id, { patientCount: request.patientCount });
      }
      emittedTopic = 'incident:merged';
      return {
        incident: await requireIncident(t, decision.incident.id), report,
        wasMerged: true, mergedIntoIncidentId: decision.incident.id,
      };
    }

    const incidentId = newId(now);
    let incident: Incident = {
      id: incidentId, code: incidentCode(incidentId), status: 'REPORTED', priority: null,
      type: request.type, lat: request.point.lat, lng: request.point.lng, address: null,
      patientCount: request.patientCount, requiredCapability: null, zoneId: null,
      primaryReportId: null, mergedIntoIncidentId: null, createdAt: now, closedAt: null,
    };
    await insertIncident(t, {
      id: incident.id, code: incident.code, status: incident.status, type: incident.type,
      lat: incident.lat, lng: incident.lng, patientCount: incident.patientCount, createdAt: now,
    });
    await appendIncidentEvent(t, {
      incidentId, eventType: 'INCIDENT_CREATED', actorType, actorId: options.actorId,
      metadata: decision.kind === 'SUGGEST'
        ? { possibleDuplicateIncidentId: decision.incident.id, confidence: decision.confidence, reason: decision.reason }
        : {},
      createdAt: now,
    });
    incident = await transitionIncident(t, incident, 'VALIDATING');

    const report = {
      id: newId(now), incidentId, source: request.source,
      reporterContact: request.reporterContact ?? null,
      description: request.description ?? null,
      lat: request.point.lat, lng: request.point.lng, accuracyM: request.accuracyM ?? null,
      wasMerged: false,
      mergeConfidence: decision.kind === 'SUGGEST' ? decision.confidence : null,
      mergeReason: decision.kind === 'SUGGEST' ? decision.reason : null,
      createdAt: now,
    };
    await insertReport(t, report, options.idempotencyKey ?? undefined);
    await setPrimaryReport(t, incidentId, report.id);
    await appendIncidentEvent(t, {
      incidentId, eventType: 'REPORT_ADDED', actorType, actorId: options.actorId,
      metadata: { reportId: report.id }, createdAt: now,
    });
    await setTriage(t, incidentId, triageResult.priority, triageResult.requiredCapability);
    await appendIncidentEvent(t, {
      incidentId, eventType: 'PRIORITY_SET', actorType: 'SYSTEM', createdAt: now,
      metadata: { priority: triageResult.priority, requiredCapability: triageResult.requiredCapability, ruleId: triageResult.ruleId },
    });
    incident = await transitionIncident(t, incident, 'OPEN');
    emittedTopic = 'incident:created';
    return {
      incident: await requireIncident(t, incidentId), report,
      wasMerged: false, mergedIntoIncidentId: null,
    };
  });

  if (emittedTopic) bus.emit(emittedTopic, result.incident);
  return result;
}

export async function appendReportToIncident(
  incidentId: string,
  request: CreateIncidentRequest,
  options: IncidentEngineOptions = {},
): Promise<CreateIncidentResponse> {
  const now = options.now ?? Date.now();
  let changed = false;
  const result = await tx(async (t) => {
    const previous = await idempotentResult(t, options.idempotencyKey);
    if (previous) return previous;
    const incident = await requireIncident(t, incidentId);
    if (['COMPLETED', 'CANCELLED', 'DUPLICATE'].includes(incident.status)) {
      throw new HttpError(409, 'INVALID_TRANSITION', 'No se pueden agregar reportes a un incidente cerrado');
    }
    const report = {
      id: newId(now), incidentId, source: request.source,
      reporterContact: request.reporterContact ?? null, description: request.description ?? null,
      lat: request.point.lat, lng: request.point.lng, accuracyM: request.accuracyM ?? null,
      wasMerged: true, mergeConfidence: 1,
      mergeReason: 'Reporte asociado explícitamente al incidente por el operador', createdAt: now,
    };
    await insertReport(t, report, options.idempotencyKey ?? undefined);
    await appendIncidentEvent(t, {
      incidentId, eventType: 'REPORT_MERGED', actorType: options.actorType ?? 'DISPATCHER',
      actorId: options.actorId, metadata: { reportId: report.id, confidence: 1, reason: report.mergeReason }, createdAt: now,
    });
    changed = true;
    return { incident, report, wasMerged: true, mergedIntoIncidentId: incidentId };
  });
  if (changed) bus.emit('incident:merged', result.incident);
  return result;
}

export async function getIncidentDetail(incidentId: string, q: Queryable = db()): Promise<IncidentDetailResponse> {
  const incident = await requireIncident(q, incidentId);
  return {
    incident,
    reports: await listReports(q, incidentId),
    events: await listEvents(q, incidentId),
    ...await readAssignmentContext(q, incidentId),
  };
}

export function listLiveIncidents(q: Queryable = db()): Promise<Incident[]> {
  return listLive(q);
}

export async function updateIncident(
  incidentId: string,
  request: UpdateIncidentRequest,
  options: IncidentEngineOptions = {},
): Promise<Incident> {
  if ('status' in request) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Los clientes envían acciones, no status');
  }
  if (request.cancel) return await cancelIncident(incidentId, request.cancel.reason, options);
  const now = options.now ?? Date.now();
  const updated = await tx(async (t) => {
    await requireIncident(t, incidentId);
    await updateOperationalFields(t, incidentId, request);
    if (request.priority || request.requiredCapability) {
      await appendIncidentEvent(t, {
        incidentId, eventType: 'MANUAL_OVERRIDE', actorType: options.actorType ?? 'DISPATCHER',
        actorId: options.actorId, createdAt: now,
        metadata: { priority: request.priority, requiredCapability: request.requiredCapability },
      });
    }
    return requireIncident(t, incidentId);
  });
  bus.emit('incident:updated', updated);
  return updated;
}

export async function cancelIncident(
  incidentId: string,
  reason: string,
  options: IncidentEngineOptions = {},
): Promise<Incident> {
  const now = options.now ?? Date.now();
  const cancelled = await tx(async (t) => {
    const current = await requireIncident(t, incidentId);
    const next = await transitionIncident(t, current, 'CANCELLED', now);
    await appendIncidentEvent(t, {
      incidentId, eventType: 'INCIDENT_CANCELLED', actorType: options.actorType ?? 'DISPATCHER',
      actorId: options.actorId, metadata: { reason }, createdAt: now,
    });
    return next;
  });
  bus.emit('incident:updated', cancelled);
  return cancelled;
}

export async function appendEvent(input: AppendEventInput, q: Queryable = db()): Promise<IncidentEvent> {
  await requireIncident(q, input.incidentId);
  return appendIncidentEvent(q, input);
}

export { areIncidentTypesCompatible, decideDeduplication } from './internal/dedup';
export { applyTriage } from './internal/triage';
