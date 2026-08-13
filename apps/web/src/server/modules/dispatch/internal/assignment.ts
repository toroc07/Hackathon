import {
  DEFAULT_WEIGHTS,
  assertAssignmentTransition,
  assertIncidentTransition,
  assertVehicleTransition,
  type Assignment,
  type AssignmentStatus,
  type IncidentEventType,
  type IncidentStatus,
  type RejectReason,
  type VehicleStatus,
} from '@dispatch/contracts';
import { newId } from '@/src/server/infra/db';
import { dispatchDatabase, type DispatchDataAccess } from './data';

interface AssignmentRow {
  id: string; incident_id: string; vehicle_id: string; dispatch_run_id: string | null;
  status: AssignmentStatus; offered_at: number; expires_at: number; responded_at: number | null;
  reject_reason: RejectReason | null; en_route_at: number | null; arrived_at: number | null;
  transport_started_at: number | null; destination_facility_id: string | null;
  completed_at: number | null; is_manual_override: number; assigned_by_user_id: string | null;
}

interface AssignmentStateRow extends AssignmentRow {
  incident_status: IncidentStatus;
  vehicle_status: VehicleStatus;
}

export class VehicleUnavailableError extends Error {
  readonly httpStatus = 409;
  readonly code = 'VEHICLE_UNAVAILABLE';
  constructor(readonly vehicleId: string) {
    super(`El vehículo ${vehicleId} dejó de estar disponible`);
    this.name = 'VehicleUnavailableError';
  }
}

export class AssignmentExpiredError extends Error {
  readonly httpStatus = 409;
  readonly code = 'ASSIGNMENT_EXPIRED';
  constructor(readonly assignmentId: string) {
    super(`La oferta ${assignmentId} ya venció`);
    this.name = 'AssignmentExpiredError';
  }
}

export class DispatchNotFoundError extends Error {
  readonly httpStatus = 404;
  readonly code = 'NOT_FOUND';
  constructor(entity: string, id: string) {
    super(`${entity} ${id} no existe`);
    this.name = 'DispatchNotFoundError';
  }
}

export function mapAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id, incidentId: row.incident_id, vehicleId: row.vehicle_id,
    dispatchRunId: row.dispatch_run_id, status: row.status, offeredAt: row.offered_at,
    expiresAt: row.expires_at, respondedAt: row.responded_at, rejectReason: row.reject_reason,
    enRouteAt: row.en_route_at, arrivedAt: row.arrived_at,
    transportStartedAt: row.transport_started_at, destinationFacilityId: row.destination_facility_id,
    completedAt: row.completed_at, isManualOverride: Boolean(row.is_manual_override),
    assignedByUserId: row.assigned_by_user_id,
  };
}

function getAssignmentState(db: DispatchDataAccess, assignmentId: string): AssignmentStateRow {
  const row = db.prepare(`
    SELECT a.*, i.status AS incident_status, v.status AS vehicle_status
    FROM assignments a JOIN incidents i ON i.id = a.incident_id
    JOIN vehicles v ON v.id = a.vehicle_id WHERE a.id = ?`).get(assignmentId) as AssignmentStateRow | undefined;
  if (!row) throw new DispatchNotFoundError('Asignación', assignmentId);
  return row;
}

function event(db: DispatchDataAccess, incidentId: string, type: IncidentEventType, now: number, metadata: object): void {
  db.prepare(`INSERT INTO incident_events (id, incident_id, event_type, actor_type, actor_id, metadata, created_at)
    VALUES (?, ?, ?, 'SYSTEM', NULL, ?, ?)`).run(newId(now), incidentId, type, JSON.stringify(metadata), now);
}

export interface AssignVehicleInput {
  incidentId: string;
  vehicleId: string;
  dispatchRunId?: string | null;
  idempotencyKey?: string | null;
  isManualOverride?: boolean;
  assignedByUserId?: string | null;
  now?: number;
  database?: DispatchDataAccess;
}

export function createAtomicAssignment(input: AssignVehicleInput): Assignment {
  const db = dispatchDatabase(input.database);
  const now = input.now ?? Date.now();
  const assignmentId = newId(now);

  return db.transaction(() => {
    if (input.idempotencyKey) {
      const existing = db.prepare('SELECT * FROM assignments WHERE idempotency_key = ?').get(input.idempotencyKey) as AssignmentRow | undefined;
      if (existing) return mapAssignment(existing);
    }
    const incident = db.prepare('SELECT status FROM incidents WHERE id = ?').get(input.incidentId) as { status: IncidentStatus } | undefined;
    if (!incident) throw new DispatchNotFoundError('Incidente', input.incidentId);
    assertIncidentTransition(incident.status, 'ASSIGNING');

    // La disponibilidad se comprueba y se toma en la misma escritura. No hay SELECT previo.
    const took = db.prepare(`UPDATE vehicles
      SET status = 'RESERVED', current_assignment_id = ?, updated_at = ?
      WHERE id = ? AND status = 'AVAILABLE'`).run(assignmentId, now, input.vehicleId);
    if (Number(took.changes) === 0) throw new VehicleUnavailableError(input.vehicleId);

    db.prepare(`INSERT INTO assignments
      (id, incident_id, vehicle_id, dispatch_run_id, status, offered_at, expires_at,
       is_manual_override, assigned_by_user_id, idempotency_key)
      VALUES (?, ?, ?, ?, 'OFFERED', ?, ?, ?, ?, ?)`)
      .run(assignmentId, input.incidentId, input.vehicleId, input.dispatchRunId ?? null,
        now, now + DEFAULT_WEIGHTS.offerTimeoutMs, input.isManualOverride ? 1 : 0,
        input.assignedByUserId ?? null, input.idempotencyKey ?? null);
    db.prepare(`UPDATE incidents SET status = 'ASSIGNING' WHERE id = ?`).run(input.incidentId);
    event(db, input.incidentId, 'VEHICLE_ASSIGNED', now, { assignmentId, vehicleId: input.vehicleId, dispatchRunId: input.dispatchRunId ?? null });
    if (input.isManualOverride) {
      event(db, input.incidentId, 'MANUAL_OVERRIDE', now, { assignmentId, vehicleId: input.vehicleId, assignedByUserId: input.assignedByUserId ?? null });
    }
    return mapAssignment(db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId) as AssignmentRow);
  }).immediate();
}

interface TransitionSpec {
  toAssignment: AssignmentStatus;
  toIncident: IncidentStatus;
  toVehicle: VehicleStatus;
  eventType: IncidentEventType;
  assignmentTimestampColumn?: string;
}

function transitionAssignment(
  assignmentId: string,
  spec: TransitionSpec,
  options: { now?: number; database?: DispatchDataAccess; destinationFacilityId?: string | null; rejectReason?: RejectReason | null } = {},
): Assignment {
  const db = dispatchDatabase(options.database);
  const now = options.now ?? Date.now();
  return db.transaction(() => {
    const row = getAssignmentState(db, assignmentId);
    if (row.status === spec.toAssignment) return mapAssignment(row);
    if (row.status === 'OFFERED' && now > row.expires_at && spec.toAssignment === 'ACCEPTED') throw new AssignmentExpiredError(assignmentId);
    assertAssignmentTransition(row.status, spec.toAssignment);
    assertIncidentTransition(row.incident_status, spec.toIncident);
    assertVehicleTransition(row.vehicle_status, spec.toVehicle);
    const timestampSql = spec.assignmentTimestampColumn ? `, ${spec.assignmentTimestampColumn} = ?` : '';
    const params: unknown[] = [spec.toAssignment];
    if (spec.assignmentTimestampColumn) params.push(now);
    const hasDestination = options.destinationFacilityId !== undefined;
    const destinationSql = hasDestination ? ', destination_facility_id = ?' : '';
    if (hasDestination) params.push(options.destinationFacilityId);
    const rejectSql = options.rejectReason ? ', reject_reason = ?' : '';
    if (options.rejectReason) params.push(options.rejectReason);
    params.push(assignmentId);
    db.prepare(`UPDATE assignments SET status = ?${timestampSql}${destinationSql}${rejectSql} WHERE id = ?`).run(...params);
    db.prepare('UPDATE incidents SET status = ? WHERE id = ?').run(spec.toIncident, row.incident_id);
    db.prepare('UPDATE vehicles SET status = ?, current_assignment_id = ?, updated_at = ? WHERE id = ?')
      .run(spec.toVehicle, spec.toVehicle === 'AVAILABLE' ? null : assignmentId, now, row.vehicle_id);
    event(db, row.incident_id, spec.eventType, now, { assignmentId, vehicleId: row.vehicle_id });
    return mapAssignment(db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId) as AssignmentRow);
  }).immediate();
}

export const acceptOffer = (id: string, options?: { now?: number; database?: DispatchDataAccess }) =>
  transitionAssignment(id, { toAssignment: 'ACCEPTED', toIncident: 'ASSIGNED', toVehicle: 'ASSIGNED', eventType: 'ASSIGNMENT_ACCEPTED', assignmentTimestampColumn: 'responded_at' }, options);
export const markOfferEnRoute = (id: string, options?: { now?: number; database?: DispatchDataAccess }) =>
  transitionAssignment(id, { toAssignment: 'EN_ROUTE', toIncident: 'EN_ROUTE', toVehicle: 'EN_ROUTE', eventType: 'VEHICLE_EN_ROUTE', assignmentTimestampColumn: 'en_route_at' }, options);
export const markOfferArrived = (id: string, options?: { now?: number; database?: DispatchDataAccess }) =>
  transitionAssignment(id, { toAssignment: 'ON_SCENE', toIncident: 'ON_SCENE', toVehicle: 'ON_SCENE', eventType: 'ARRIVED_ON_SCENE', assignmentTimestampColumn: 'arrived_at' }, options);
export const startOfferTransport = (id: string, destinationFacilityId: string | null, options?: { now?: number; database?: DispatchDataAccess }) =>
  transitionAssignment(id, { toAssignment: 'TRANSPORTING', toIncident: 'TRANSPORTING', toVehicle: 'TRANSPORTING', eventType: 'TRANSPORT_STARTED', assignmentTimestampColumn: 'transport_started_at' }, { ...options, destinationFacilityId });
export const completeOffer = (id: string, options?: { now?: number; database?: DispatchDataAccess }) =>
  transitionAssignment(id, { toAssignment: 'COMPLETED', toIncident: 'COMPLETED', toVehicle: 'AVAILABLE', eventType: 'INCIDENT_COMPLETED', assignmentTimestampColumn: 'completed_at' }, options);

export function rejectOffer(id: string, reason: RejectReason, options?: { now?: number; database?: DispatchDataAccess }): Assignment {
  return transitionAssignment(id, { toAssignment: 'REJECTED', toIncident: 'OPEN', toVehicle: 'AVAILABLE', eventType: 'ASSIGNMENT_REJECTED', assignmentTimestampColumn: 'responded_at' }, { ...options, rejectReason: reason });
}
