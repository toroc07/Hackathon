import {
  ACTIVE_ASSIGNMENT_STATUSES,
  zAssignment,
  zIncident,
  zIncidentEvent,
  zIncidentReport,
  zVehicleWithLocation,
  type Incident,
  type IncidentEvent,
  type IncidentReport,
  type IncidentStatus,
  type IncidentType,
} from '@dispatch/contracts';
import type { SqliteDatabase } from '@/src/server/infra/db';

type Row = Record<string, unknown>;

const bool = (value: unknown) => value === 1;

export function mapIncident(row: Row): Incident {
  return zIncident.parse({
    id: row.id, code: row.code, status: row.status, priority: row.priority, type: row.type,
    lat: row.lat, lng: row.lng, address: row.address, patientCount: row.patient_count,
    requiredCapability: row.required_capability, zoneId: row.zone_id,
    primaryReportId: row.primary_report_id, mergedIntoIncidentId: row.merged_into_incident_id,
    createdAt: row.created_at, closedAt: row.closed_at,
  });
}

export function mapReport(row: Row): IncidentReport {
  return zIncidentReport.parse({
    id: row.id, incidentId: row.incident_id, source: row.source,
    reporterContact: row.reporter_contact, description: row.description,
    lat: row.lat, lng: row.lng, accuracyM: row.accuracy_m,
    wasMerged: bool(row.was_merged), mergeConfidence: row.merge_confidence,
    mergeReason: row.merge_reason, createdAt: row.created_at,
  });
}

export function findIncident(db: SqliteDatabase, id: string): Incident | null {
  const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as Row | undefined;
  return row ? mapIncident(row) : null;
}

export function findReportByIdempotencyKey(db: SqliteDatabase, key: string): IncidentReport | null {
  const row = db.prepare('SELECT * FROM incident_reports WHERE idempotency_key = ?').get(key) as Row | undefined;
  return row ? mapReport(row) : null;
}

export function findIncidentForReport(db: SqliteDatabase, report: IncidentReport): Incident | null {
  return findIncident(db, report.incidentId);
}

export function listRecentLiveIncidents(db: SqliteDatabase, since: number): Incident[] {
  const rows = db.prepare(`
    SELECT * FROM incidents
    WHERE created_at >= ? AND status NOT IN ('COMPLETED','CANCELLED','DUPLICATE')
    ORDER BY created_at DESC
  `).all(since) as Row[];
  return rows.map(mapIncident);
}

export function listLive(db: SqliteDatabase): Incident[] {
  const rows = db.prepare(`
    SELECT * FROM incidents
    WHERE status NOT IN ('COMPLETED','CANCELLED','DUPLICATE')
    ORDER BY CASE priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, created_at DESC
  `).all() as Row[];
  return rows.map(mapIncident);
}

export interface InsertIncidentInput {
  id: string; code: string; status: IncidentStatus; type: IncidentType;
  lat: number; lng: number; patientCount: number; createdAt: number;
}

export function insertIncident(db: SqliteDatabase, input: InsertIncidentInput): void {
  db.prepare(`
    INSERT INTO incidents (id, code, status, type, lat, lng, patient_count, created_at)
    VALUES (@id, @code, @status, @type, @lat, @lng, @patientCount, @createdAt)
  `).run(input);
}

export function setIncidentStatus(db: SqliteDatabase, id: string, status: IncidentStatus, closedAt: number | null = null): void {
  db.prepare('UPDATE incidents SET status = ?, closed_at = ? WHERE id = ?').run(status, closedAt, id);
}

export function insertReport(db: SqliteDatabase, report: IncidentReport, idempotencyKey?: string): void {
  db.prepare(`
    INSERT INTO incident_reports (
      id, incident_id, source, reporter_contact, description, lat, lng, accuracy_m,
      was_merged, merge_confidence, merge_reason, created_at, idempotency_key
    ) VALUES (
      @id, @incidentId, @source, @reporterContact, @description, @lat, @lng, @accuracyM,
      @wasMerged, @mergeConfidence, @mergeReason, @createdAt, @idempotencyKey
    )
  `).run({ ...report, wasMerged: report.wasMerged ? 1 : 0, idempotencyKey: idempotencyKey ?? null });
}

export function setPrimaryReport(db: SqliteDatabase, incidentId: string, reportId: string): void {
  db.prepare('UPDATE incidents SET primary_report_id = ? WHERE id = ?').run(reportId, incidentId);
}

export function setTriage(db: SqliteDatabase, incidentId: string, priority: string, capability: string): void {
  db.prepare('UPDATE incidents SET priority = ?, required_capability = ? WHERE id = ?').run(priority, capability, incidentId);
}

export function updateOperationalFields(db: SqliteDatabase, incidentId: string, fields: {
  patientCount?: number; address?: string; requiredCapability?: string; priority?: string;
}): void {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const columns = {
    patientCount: 'patient_count', address: 'address',
    requiredCapability: 'required_capability', priority: 'priority',
  } as const;
  for (const [key, column] of Object.entries(columns)) {
    const value = fields[key as keyof typeof fields];
    if (value !== undefined) { assignments.push(`${column} = ?`); values.push(value); }
  }
  if (assignments.length > 0) {
    db.prepare(`UPDATE incidents SET ${assignments.join(', ')} WHERE id = ?`).run(...values, incidentId);
  }
}

export function listReports(db: SqliteDatabase, incidentId: string): IncidentReport[] {
  return (db.prepare('SELECT * FROM incident_reports WHERE incident_id = ? ORDER BY created_at').all(incidentId) as Row[]).map(mapReport);
}

export function listEvents(db: SqliteDatabase, incidentId: string): IncidentEvent[] {
  return (db.prepare('SELECT * FROM incident_events WHERE incident_id = ? ORDER BY created_at, id').all(incidentId) as Row[])
    .map((row) => zIncidentEvent.parse({
      id: row.id, incidentId: row.incident_id, eventType: row.event_type,
      actorType: row.actor_type, actorId: row.actor_id,
      metadata: JSON.parse(String(row.metadata)), createdAt: row.created_at,
    }));
}

export function readAssignmentContext(db: SqliteDatabase, incidentId: string) {
  const placeholders = ACTIVE_ASSIGNMENT_STATUSES.map(() => '?').join(',');
  const assignmentRow = db.prepare(`
    SELECT * FROM assignments WHERE incident_id = ? AND status IN (${placeholders}) ORDER BY offered_at DESC LIMIT 1
  `).get(incidentId, ...ACTIVE_ASSIGNMENT_STATUSES) as Row | undefined;
  if (!assignmentRow) return { assignment: null, assignedVehicle: null, liveEtaSeconds: null };
  const assignment = zAssignment.parse({
    id: assignmentRow.id, incidentId: assignmentRow.incident_id, vehicleId: assignmentRow.vehicle_id,
    dispatchRunId: assignmentRow.dispatch_run_id, status: assignmentRow.status,
    offeredAt: assignmentRow.offered_at, expiresAt: assignmentRow.expires_at,
    respondedAt: assignmentRow.responded_at, rejectReason: assignmentRow.reject_reason,
    enRouteAt: assignmentRow.en_route_at, arrivedAt: assignmentRow.arrived_at,
    transportStartedAt: assignmentRow.transport_started_at,
    destinationFacilityId: assignmentRow.destination_facility_id,
    completedAt: assignmentRow.completed_at, isManualOverride: bool(assignmentRow.is_manual_override),
    assignedByUserId: assignmentRow.assigned_by_user_id,
  });
  const vehicleRow = db.prepare(`
    SELECT v.*, l.lat location_lat, l.lng location_lng, l.heading, l.speed_kmh, l.recorded_at
    FROM vehicles v LEFT JOIN vehicle_current_location l ON l.vehicle_id = v.id WHERE v.id = ?
  `).get(assignment.vehicleId) as Row | undefined;
  const assignedVehicle = vehicleRow ? zVehicleWithLocation.parse({
    id: vehicleRow.id, orgId: vehicleRow.org_id, callsign: vehicleRow.callsign,
    status: vehicleRow.status, capabilityLevel: vehicleRow.capability_level,
    capabilities: JSON.parse(String(vehicleRow.capabilities)), homeBaseId: vehicleRow.home_base_id,
    operatingZoneId: vehicleRow.operating_zone_id, currentAssignmentId: vehicleRow.current_assignment_id,
    activeShiftId: vehicleRow.active_shift_id, isSimulated: bool(vehicleRow.is_simulated), updatedAt: vehicleRow.updated_at,
    location: vehicleRow.recorded_at == null ? null : {
      vehicleId: vehicleRow.id, lat: vehicleRow.location_lat, lng: vehicleRow.location_lng,
      heading: vehicleRow.heading, speedKmh: vehicleRow.speed_kmh, recordedAt: vehicleRow.recorded_at,
    },
    isStale: vehicleRow.recorded_at == null || Date.now() - Number(vehicleRow.recorded_at) > 60_000,
  }) : null;
  const etaRow = db.prepare(`
    SELECT dc.eta_seconds
    FROM dispatch_candidates dc
    JOIN dispatch_runs dr ON dr.id = dc.dispatch_run_id
    WHERE dr.incident_id = ? AND dc.vehicle_id = ? AND dc.excluded_reason IS NULL
    ORDER BY dr.created_at DESC, dr.id DESC
    LIMIT 1
  `).get(incidentId, assignment.vehicleId) as Row | undefined;
  return {
    assignment,
    assignedVehicle,
    liveEtaSeconds: etaRow?.eta_seconds == null ? null : Number(etaRow.eta_seconds),
  };
}
