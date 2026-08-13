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
import { getDatabase, newId, type SqliteDatabase } from '@/src/server/infra/db';
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
  db?: SqliteDatabase;
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

function requireIncident(db: SqliteDatabase, incidentId: string): Incident {
  const incident = findIncident(db, incidentId);
  if (!incident) throw new HttpError(404, 'NOT_FOUND', 'Incidente no encontrado');
  return incident;
}

function transitionIncident(
  db: SqliteDatabase,
  incident: Incident,
  next: IncidentStatus,
  closedAt: number | null = null,
): Incident {
  assertIncidentTransition(incident.status, next);
  setIncidentStatus(db, incident.id, next, closedAt);
  return { ...incident, status: next, closedAt };
}

function incidentCode(id: string): string {
  return `INC-${id.slice(-3)}`;
}

function idempotentResult(db: SqliteDatabase, key?: string | null): CreateIncidentResponse | null {
  if (!key) return null;
  const report = findReportByIdempotencyKey(db, key);
  if (!report) return null;
  const incident = findIncidentForReport(db, report);
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

export function createIncidentFromReport(
  request: CreateIncidentRequest,
  options: IncidentEngineOptions = {},
): CreateIncidentResponse {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const actorType = options.actorType ?? 'REPORTER';
  let emittedTopic: 'incident:created' | 'incident:merged' | null = null;
  const result = db.transaction(() => {
    const previous = idempotentResult(db, options.idempotencyKey);
    if (previous) return previous;

    const triageResult = applyTriage(request.type, signalsFor(request));
    const decision = decideDeduplication(
      { type: request.type, point: request.point, accuracyM: request.accuracyM, createdAt: now },
      listRecentLiveIncidents(db, now - LIVE_LOOKBACK_MS),
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
      insertReport(db, report, options.idempotencyKey ?? undefined);
      appendIncidentEvent(db, {
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
        setTriage(db, decision.incident.id, priority, capability);
        appendIncidentEvent(db, {
          incidentId: decision.incident.id, eventType: 'PRIORITY_SET', actorType: 'SYSTEM', createdAt: now,
          metadata: { priority, requiredCapability: capability, ruleId: triageResult.ruleId, escalatedByReportId: report.id },
        });
      }
      if (request.patientCount > decision.incident.patientCount) {
        updateOperationalFields(db, decision.incident.id, { patientCount: request.patientCount });
      }
      emittedTopic = 'incident:merged';
      return {
        incident: requireIncident(db, decision.incident.id), report,
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
    insertIncident(db, {
      id: incident.id, code: incident.code, status: incident.status, type: incident.type,
      lat: incident.lat, lng: incident.lng, patientCount: incident.patientCount, createdAt: now,
    });
    appendIncidentEvent(db, {
      incidentId, eventType: 'INCIDENT_CREATED', actorType, actorId: options.actorId,
      metadata: decision.kind === 'SUGGEST'
        ? { possibleDuplicateIncidentId: decision.incident.id, confidence: decision.confidence, reason: decision.reason }
        : {},
      createdAt: now,
    });
    incident = transitionIncident(db, incident, 'VALIDATING');

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
    insertReport(db, report, options.idempotencyKey ?? undefined);
    setPrimaryReport(db, incidentId, report.id);
    appendIncidentEvent(db, {
      incidentId, eventType: 'REPORT_ADDED', actorType, actorId: options.actorId,
      metadata: { reportId: report.id }, createdAt: now,
    });
    setTriage(db, incidentId, triageResult.priority, triageResult.requiredCapability);
    appendIncidentEvent(db, {
      incidentId, eventType: 'PRIORITY_SET', actorType: 'SYSTEM', createdAt: now,
      metadata: { priority: triageResult.priority, requiredCapability: triageResult.requiredCapability, ruleId: triageResult.ruleId },
    });
    incident = transitionIncident(db, incident, 'OPEN');
    emittedTopic = 'incident:created';
    return {
      incident: requireIncident(db, incidentId), report,
      wasMerged: false, mergedIntoIncidentId: null,
    };
  }).immediate();

  if (emittedTopic) bus.emit(emittedTopic, result.incident);
  return result;
}

export function appendReportToIncident(
  incidentId: string,
  request: CreateIncidentRequest,
  options: IncidentEngineOptions = {},
): CreateIncidentResponse {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  let changed = false;
  const result = db.transaction(() => {
    const previous = idempotentResult(db, options.idempotencyKey);
    if (previous) return previous;
    const incident = requireIncident(db, incidentId);
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
    insertReport(db, report, options.idempotencyKey ?? undefined);
    appendIncidentEvent(db, {
      incidentId, eventType: 'REPORT_MERGED', actorType: options.actorType ?? 'DISPATCHER',
      actorId: options.actorId, metadata: { reportId: report.id, confidence: 1, reason: report.mergeReason }, createdAt: now,
    });
    changed = true;
    return { incident, report, wasMerged: true, mergedIntoIncidentId: incidentId };
  }).immediate();
  if (changed) bus.emit('incident:merged', result.incident);
  return result;
}

export function getIncidentDetail(incidentId: string, db: SqliteDatabase = getDatabase()): IncidentDetailResponse {
  const incident = requireIncident(db, incidentId);
  return {
    incident,
    reports: listReports(db, incidentId),
    events: listEvents(db, incidentId),
    ...readAssignmentContext(db, incidentId),
  };
}

export function listLiveIncidents(db: SqliteDatabase = getDatabase()): Incident[] {
  return listLive(db);
}

export function updateIncident(
  incidentId: string,
  request: UpdateIncidentRequest,
  options: IncidentEngineOptions = {},
): Incident {
  if ('status' in request) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Los clientes envían acciones, no status');
  }
  if (request.cancel) return cancelIncident(incidentId, request.cancel.reason, options);
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const updated = db.transaction(() => {
    requireIncident(db, incidentId);
    updateOperationalFields(db, incidentId, request);
    if (request.priority || request.requiredCapability) {
      appendIncidentEvent(db, {
        incidentId, eventType: 'MANUAL_OVERRIDE', actorType: options.actorType ?? 'DISPATCHER',
        actorId: options.actorId, createdAt: now,
        metadata: { priority: request.priority, requiredCapability: request.requiredCapability },
      });
    }
    return requireIncident(db, incidentId);
  }).immediate();
  bus.emit('incident:updated', updated);
  return updated;
}

export function cancelIncident(
  incidentId: string,
  reason: string,
  options: IncidentEngineOptions = {},
): Incident {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const cancelled = db.transaction(() => {
    const current = requireIncident(db, incidentId);
    const next = transitionIncident(db, current, 'CANCELLED', now);
    appendIncidentEvent(db, {
      incidentId, eventType: 'INCIDENT_CANCELLED', actorType: options.actorType ?? 'DISPATCHER',
      actorId: options.actorId, metadata: { reason }, createdAt: now,
    });
    return next;
  }).immediate();
  bus.emit('incident:updated', cancelled);
  return cancelled;
}

export function appendEvent(input: AppendEventInput, db: SqliteDatabase = getDatabase()): IncidentEvent {
  requireIncident(db, input.incidentId);
  return appendIncidentEvent(db, input);
}

export { areIncidentTypesCompatible, decideDeduplication } from './internal/dedup';
export { applyTriage } from './internal/triage';
