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
import { db, newId, tx, type Queryable } from '@/src/server/infra/db';

interface AssignmentRow extends Record<string, unknown> {
  id: string; incident_id: string; vehicle_id: string; dispatch_run_id: string | null;
  status: AssignmentStatus; offered_at: number; expires_at: number; responded_at: number | null;
  reject_reason: RejectReason | null; en_route_at: number | null; arrived_at: number | null;
  transport_started_at: number | null; destination_facility_id: string | null;
  completed_at: number | null; is_manual_override: boolean; assigned_by_user_id: string | null;
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
    completedAt: row.completed_at, isManualOverride: row.is_manual_override,
    assignedByUserId: row.assigned_by_user_id,
  };
}

async function getAssignmentState(q: Queryable, assignmentId: string): Promise<AssignmentStateRow> {
  const row = await q.one<AssignmentStateRow>(`
    SELECT a.*, i.status AS incident_status, v.status AS vehicle_status
    FROM assignments a JOIN incidents i ON i.id = a.incident_id
    JOIN vehicles v ON v.id = a.vehicle_id WHERE a.id = ?`, [assignmentId]);
  if (!row) throw new DispatchNotFoundError('Asignación', assignmentId);
  return row;
}

async function event(
  q: Queryable,
  incidentId: string,
  type: IncidentEventType,
  now: number,
  metadata: object,
): Promise<void> {
  await q.run(`INSERT INTO incident_events (id, incident_id, event_type, actor_type, actor_id, metadata, created_at)
    VALUES (?, ?, ?, 'SYSTEM', NULL, ?, ?)`, [newId(now), incidentId, type, JSON.stringify(metadata), now]);
}

export interface AssignVehicleInput {
  incidentId: string;
  vehicleId: string;
  dispatchRunId?: string | null;
  idempotencyKey?: string | null;
  isManualOverride?: boolean;
  assignedByUserId?: string | null;
  now?: number;
  q?: Queryable;
}

export async function createAtomicAssignment(input: AssignVehicleInput): Promise<Assignment> {
  const now = input.now ?? Date.now();
  const assignmentId = newId(now);
  const operation = async (t: Queryable): Promise<Assignment> => {
    if (input.idempotencyKey) {
      const existing = await t.one<AssignmentRow>(
        'SELECT * FROM assignments WHERE idempotency_key = ?',
        [input.idempotencyKey],
      );
      if (existing) return mapAssignment(existing);
    }
    const incident = await t.one<{ status: IncidentStatus } & Record<string, unknown>>(
      'SELECT status FROM incidents WHERE id = ?',
      [input.incidentId],
    );
    if (!incident) throw new DispatchNotFoundError('Incidente', input.incidentId);
    assertIncidentTransition(incident.status, 'ASSIGNING');

    // Esta escritura condicional toma y bloquea la fila. No separar en SELECT + UPDATE.
    const took = await t.run(`UPDATE vehicles
      SET status = 'RESERVED', current_assignment_id = ?, updated_at = ?
      WHERE id = ? AND status = 'AVAILABLE'`, [assignmentId, now, input.vehicleId]);
    if (took.changes === 0) throw new VehicleUnavailableError(input.vehicleId);

    const inserted = await t.one<AssignmentRow>(`INSERT INTO assignments
      (id, incident_id, vehicle_id, dispatch_run_id, status, offered_at, expires_at,
       is_manual_override, assigned_by_user_id, idempotency_key)
      VALUES (?, ?, ?, ?, 'OFFERED', ?, ?, ?, ?, ?)
      RETURNING *`, [
      assignmentId, input.incidentId, input.vehicleId, input.dispatchRunId ?? null,
      now, now + DEFAULT_WEIGHTS.offerTimeoutMs, input.isManualOverride ?? false,
      input.assignedByUserId ?? null, input.idempotencyKey ?? null,
    ]);
    if (!inserted) throw new Error(`No se pudo crear la asignación ${assignmentId}`);
    await t.run(`UPDATE incidents SET status = 'ASSIGNING' WHERE id = ?`, [input.incidentId]);
    await event(t, input.incidentId, 'VEHICLE_ASSIGNED', now, {
      assignmentId, vehicleId: input.vehicleId, dispatchRunId: input.dispatchRunId ?? null,
    });
    if (input.isManualOverride) {
      await event(t, input.incidentId, 'MANUAL_OVERRIDE', now, {
        assignmentId, vehicleId: input.vehicleId, assignedByUserId: input.assignedByUserId ?? null,
      });
    }
    return mapAssignment(inserted);
  };

  return input.q ? operation(input.q) : tx(operation);
}

interface TransitionSpec {
  toAssignment: AssignmentStatus;
  toIncident: IncidentStatus;
  toVehicle: VehicleStatus;
  eventType: IncidentEventType;
  assignmentTimestampColumn?: string;
}

export interface AssignmentOperationOptions {
  now?: number;
  q?: Queryable;
  destinationFacilityId?: string | null;
  rejectReason?: RejectReason | null;
}

async function transitionAssignment(
  assignmentId: string,
  spec: TransitionSpec,
  options: AssignmentOperationOptions = {},
): Promise<Assignment> {
  const now = options.now ?? Date.now();
  const operation = async (t: Queryable): Promise<Assignment> => {
    const row = await getAssignmentState(t, assignmentId);
    if (row.status === spec.toAssignment) return mapAssignment(row);
    if (row.status === 'OFFERED' && now > row.expires_at && spec.toAssignment === 'ACCEPTED') {
      throw new AssignmentExpiredError(assignmentId);
    }
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
    const updated = await t.one<AssignmentRow>(
      `UPDATE assignments SET status = ?${timestampSql}${destinationSql}${rejectSql} WHERE id = ? RETURNING *`,
      params,
    );
    if (!updated) throw new DispatchNotFoundError('Asignación', assignmentId);
    await t.run('UPDATE incidents SET status = ? WHERE id = ?', [spec.toIncident, row.incident_id]);
    await t.run('UPDATE vehicles SET status = ?, current_assignment_id = ?, updated_at = ? WHERE id = ?', [
      spec.toVehicle, spec.toVehicle === 'AVAILABLE' ? null : assignmentId, now, row.vehicle_id,
    ]);
    await event(t, row.incident_id, spec.eventType, now, { assignmentId, vehicleId: row.vehicle_id });
    return mapAssignment(updated);
  };

  return options.q ? operation(options.q) : tx(operation);
}

export const acceptOffer = (id: string, options?: AssignmentOperationOptions) =>
  transitionAssignment(id, { toAssignment: 'ACCEPTED', toIncident: 'ASSIGNED', toVehicle: 'ASSIGNED', eventType: 'ASSIGNMENT_ACCEPTED', assignmentTimestampColumn: 'responded_at' }, options);
export const markOfferEnRoute = (id: string, options?: AssignmentOperationOptions) =>
  transitionAssignment(id, { toAssignment: 'EN_ROUTE', toIncident: 'EN_ROUTE', toVehicle: 'EN_ROUTE', eventType: 'VEHICLE_EN_ROUTE', assignmentTimestampColumn: 'en_route_at' }, options);
export const markOfferArrived = (id: string, options?: AssignmentOperationOptions) =>
  transitionAssignment(id, { toAssignment: 'ON_SCENE', toIncident: 'ON_SCENE', toVehicle: 'ON_SCENE', eventType: 'ARRIVED_ON_SCENE', assignmentTimestampColumn: 'arrived_at' }, options);
export const startOfferTransport = (id: string, destinationFacilityId: string | null, options?: AssignmentOperationOptions) =>
  transitionAssignment(id, { toAssignment: 'TRANSPORTING', toIncident: 'TRANSPORTING', toVehicle: 'TRANSPORTING', eventType: 'TRANSPORT_STARTED', assignmentTimestampColumn: 'transport_started_at' }, { ...options, destinationFacilityId });
export const completeOffer = (id: string, options?: AssignmentOperationOptions) =>
  transitionAssignment(id, { toAssignment: 'COMPLETED', toIncident: 'COMPLETED', toVehicle: 'AVAILABLE', eventType: 'INCIDENT_COMPLETED', assignmentTimestampColumn: 'completed_at' }, options);

export function rejectOffer(
  id: string,
  reason: RejectReason,
  options?: AssignmentOperationOptions,
): Promise<Assignment> {
  return transitionAssignment(id, { toAssignment: 'REJECTED', toIncident: 'OPEN', toVehicle: 'AVAILABLE', eventType: 'ASSIGNMENT_REJECTED', assignmentTimestampColumn: 'responded_at' }, { ...options, rejectReason: reason });
}
