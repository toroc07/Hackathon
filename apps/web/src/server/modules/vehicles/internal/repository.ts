import {
  ACTIVE_ASSIGNMENT_STATUSES,
  zAssignment,
  zIncident,
  zVehicleWithLocation,
  type Assignment,
  type Incident,
  type VehicleStatus,
  type VehicleWithLocation,
} from '@dispatch/contracts';
import { db, type Queryable } from '@/src/server/infra/db';

type Row = Record<string, unknown>;

const bool = (value: unknown) => value === true;

const VEHICLE_SELECT = `
  SELECT v.*, l.lat AS location_lat, l.lng AS location_lng,
    l.heading AS location_heading, l.speed_kmh AS location_speed_kmh,
    l.recorded_at AS location_recorded_at
  FROM vehicles v
  LEFT JOIN vehicle_current_location l ON l.vehicle_id = v.id
`;

export function mapVehicle(row: Row, now = Date.now()): VehicleWithLocation {
  const recordedAt = row.location_recorded_at;
  return zVehicleWithLocation.parse({
    id: row.id,
    orgId: row.org_id,
    callsign: row.callsign,
    status: row.status,
    capabilityLevel: row.capability_level,
    capabilities: JSON.parse(String(row.capabilities)),
    homeBaseId: row.home_base_id,
    operatingZoneId: row.operating_zone_id,
    currentAssignmentId: row.current_assignment_id,
    activeShiftId: row.active_shift_id,
    isSimulated: bool(row.is_simulated),
    updatedAt: row.updated_at,
    location: recordedAt == null ? null : {
      vehicleId: row.id,
      lat: row.location_lat,
      lng: row.location_lng,
      heading: row.location_heading,
      speedKmh: row.location_speed_kmh,
      recordedAt,
    },
    isStale: recordedAt == null || now - (recordedAt as number) > 60_000,
  });
}

export async function findVehicle(vehicleId: string, q: Queryable = db()): Promise<VehicleWithLocation | null> {
  const row = await q.one<Row>(`${VEHICLE_SELECT} WHERE v.id = ?`, [vehicleId]);
  return row ? mapVehicle(row) : null;
}

export async function findVehicles(status?: VehicleStatus, q: Queryable = db()): Promise<VehicleWithLocation[]> {
  const where = status ? 'WHERE v.status = ?' : '';
  const rows = await q.many<Row>(`${VEHICLE_SELECT} ${where} ORDER BY v.callsign`, status ? [status] : []);
  return rows.map((row) => mapVehicle(row));
}

export async function findAvailableVehicles(q: Queryable = db()): Promise<VehicleWithLocation[]> {
  const rows = await q.many<Row>(`${VEHICLE_SELECT}
    WHERE v.status = 'AVAILABLE' AND v.active_shift_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM assignments a
        WHERE a.vehicle_id = v.id
          AND a.status IN (${ACTIVE_ASSIGNMENT_STATUSES.map(() => '?').join(',')})
      )
    ORDER BY v.callsign
  `, [...ACTIVE_ASSIGNMENT_STATUSES]);
  return rows.map((row) => mapVehicle(row));
}

export async function setVehicleState(
  vehicleId: string,
  status: VehicleStatus,
  updatedAt: number,
  activeShiftId?: string | null,
  q: Queryable = db(),
): Promise<void> {
  if (activeShiftId === undefined) {
    await q.run('UPDATE vehicles SET status = ?, updated_at = ? WHERE id = ?', [status, updatedAt, vehicleId]);
    return;
  }
  await q.run('UPDATE vehicles SET status = ?, active_shift_id = ?, updated_at = ? WHERE id = ?',
    [status, activeShiftId, updatedAt, vehicleId]);
}

export interface ActiveAssignmentContext {
  assignment: Assignment;
  incident: Incident;
}

export async function findActiveAssignment(
  vehicleId: string,
  q: Queryable = db(),
): Promise<ActiveAssignmentContext | null> {
  const row = await q.one<Row>(`
    SELECT
      a.id AS assignment_id, a.incident_id, a.vehicle_id, a.dispatch_run_id,
      a.status AS assignment_status, a.offered_at, a.expires_at, a.responded_at,
      a.reject_reason, a.en_route_at, a.arrived_at, a.transport_started_at,
      a.destination_facility_id, a.completed_at, a.is_manual_override,
      a.assigned_by_user_id,
      i.id, i.code, i.status, i.priority, i.type, i.lat, i.lng, i.address,
      i.patient_count, i.required_capability, i.zone_id, i.primary_report_id,
      i.merged_into_incident_id, i.created_at, i.closed_at
    FROM assignments a
    JOIN incidents i ON i.id = a.incident_id
    WHERE a.vehicle_id = ? AND a.status IN (${ACTIVE_ASSIGNMENT_STATUSES.map(() => '?').join(',')})
    ORDER BY a.offered_at DESC LIMIT 1
  `, [vehicleId, ...ACTIVE_ASSIGNMENT_STATUSES]);
  if (!row) return null;
  return {
    assignment: zAssignment.parse({
      id: row.assignment_id, incidentId: row.incident_id, vehicleId: row.vehicle_id,
      dispatchRunId: row.dispatch_run_id, status: row.assignment_status,
      offeredAt: row.offered_at, expiresAt: row.expires_at,
      respondedAt: row.responded_at, rejectReason: row.reject_reason,
      enRouteAt: row.en_route_at, arrivedAt: row.arrived_at,
      transportStartedAt: row.transport_started_at,
      destinationFacilityId: row.destination_facility_id,
      completedAt: row.completed_at, isManualOverride: bool(row.is_manual_override),
      assignedByUserId: row.assigned_by_user_id,
    }),
    incident: zIncident.parse({
      id: row.id, code: row.code, status: row.status, priority: row.priority,
      type: row.type, lat: row.lat, lng: row.lng, address: row.address,
      patientCount: row.patient_count, requiredCapability: row.required_capability,
      zoneId: row.zone_id, primaryReportId: row.primary_report_id,
      mergedIntoIncidentId: row.merged_into_incident_id,
      createdAt: row.created_at, closedAt: row.closed_at,
    }),
  };
}

export async function vehicleExists(vehicleId: string, q: Queryable = db()): Promise<boolean> {
  return (await q.one('SELECT 1 FROM vehicles WHERE id = ?', [vehicleId])) !== undefined;
}
