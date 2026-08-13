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
import type { Queryable } from '@/src/server/infra/db';

type Row = Record<string, unknown>;

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
    wasMerged: row.was_merged, mergeConfidence: row.merge_confidence,
    mergeReason: row.merge_reason, createdAt: row.created_at,
  });
}

export async function findIncident(q: Queryable, id: string): Promise<Incident | null> {
  const row = await q.one<Row>('SELECT * FROM incidents WHERE id = ?', [id]);
  return row ? mapIncident(row) : null;
}

export async function findReportByIdempotencyKey(q: Queryable, key: string): Promise<IncidentReport | null> {
  const row = await q.one<Row>('SELECT * FROM incident_reports WHERE idempotency_key = ?', [key]);
  return row ? mapReport(row) : null;
}

export async function findIncidentForReport(q: Queryable, report: IncidentReport): Promise<Incident | null> {
  return await findIncident(q, report.incidentId);
}

export async function listRecentLiveIncidents(q: Queryable, since: number): Promise<Incident[]> {
  const rows = await q.many<Row>(`
    SELECT * FROM incidents
    WHERE created_at >= ? AND status NOT IN ('COMPLETED','CANCELLED','DUPLICATE')
    ORDER BY created_at DESC
  `, [since]);
  return rows.map(mapIncident);
}

export async function listLive(q: Queryable): Promise<Incident[]> {
  const rows = await q.many<Row>(`
    SELECT * FROM incidents
    WHERE status NOT IN ('COMPLETED','CANCELLED','DUPLICATE')
    ORDER BY CASE priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, created_at DESC
  `);
  return rows.map(mapIncident);
}

export interface InsertIncidentInput {
  id: string; code: string; status: IncidentStatus; type: IncidentType;
  lat: number; lng: number; patientCount: number; createdAt: number;
}

export async function insertIncident(q: Queryable, input: InsertIncidentInput): Promise<void> {
  await q.run(`
    INSERT INTO incidents (id, code, status, type, lat, lng, patient_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [input.id, input.code, input.status, input.type, input.lat, input.lng, input.patientCount, input.createdAt]);
}

export async function setIncidentStatus(q: Queryable, id: string, status: IncidentStatus, closedAt: number | null = null): Promise<void> {
  await q.run('UPDATE incidents SET status = ?, closed_at = ? WHERE id = ?', [status, closedAt, id]);
}

export async function insertReport(q: Queryable, report: IncidentReport, idempotencyKey?: string): Promise<void> {
  await q.run(`
    INSERT INTO incident_reports (
      id, incident_id, source, reporter_contact, description, lat, lng, accuracy_m,
      was_merged, merge_confidence, merge_reason, created_at, idempotency_key
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `, [
    report.id, report.incidentId, report.source, report.reporterContact, report.description,
    report.lat, report.lng, report.accuracyM, report.wasMerged, report.mergeConfidence,
    report.mergeReason, report.createdAt, idempotencyKey ?? null,
  ]);
}

export async function setPrimaryReport(q: Queryable, incidentId: string, reportId: string): Promise<void> {
  await q.run('UPDATE incidents SET primary_report_id = ? WHERE id = ?', [reportId, incidentId]);
}

export async function setTriage(q: Queryable, incidentId: string, priority: string, capability: string): Promise<void> {
  await q.run('UPDATE incidents SET priority = ?, required_capability = ? WHERE id = ?', [priority, capability, incidentId]);
}

export async function updateOperationalFields(q: Queryable, incidentId: string, fields: {
  patientCount?: number; address?: string; requiredCapability?: string; priority?: string;
}): Promise<void> {
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
    await q.run(`UPDATE incidents SET ${assignments.join(', ')} WHERE id = ?`, [...values, incidentId]);
  }
}

export async function listReports(q: Queryable, incidentId: string): Promise<IncidentReport[]> {
  return (await q.many<Row>('SELECT * FROM incident_reports WHERE incident_id = ? ORDER BY created_at', [incidentId])).map(mapReport);
}

export async function listEvents(q: Queryable, incidentId: string): Promise<IncidentEvent[]> {
  return (await q.many<Row>('SELECT * FROM incident_events WHERE incident_id = ? ORDER BY created_at, id', [incidentId]))
    .map((row) => zIncidentEvent.parse({
      id: row.id, incidentId: row.incident_id, eventType: row.event_type,
      actorType: row.actor_type, actorId: row.actor_id,
      metadata: JSON.parse(String(row.metadata)), createdAt: row.created_at,
    }));
}

export async function readAssignmentContext(q: Queryable, incidentId: string) {
  const placeholders = ACTIVE_ASSIGNMENT_STATUSES.map(() => '?').join(',');
  const assignmentRow = await q.one<Row>(`
    SELECT * FROM assignments WHERE incident_id = ? AND status IN (${placeholders}) ORDER BY offered_at DESC LIMIT 1
  `, [incidentId, ...ACTIVE_ASSIGNMENT_STATUSES]);
  if (!assignmentRow) return { assignment: null, assignedVehicle: null, liveEtaSeconds: null };
  const assignment = zAssignment.parse({
    id: assignmentRow.id, incidentId: assignmentRow.incident_id, vehicleId: assignmentRow.vehicle_id,
    dispatchRunId: assignmentRow.dispatch_run_id, status: assignmentRow.status,
    offeredAt: assignmentRow.offered_at, expiresAt: assignmentRow.expires_at,
    respondedAt: assignmentRow.responded_at, rejectReason: assignmentRow.reject_reason,
    enRouteAt: assignmentRow.en_route_at, arrivedAt: assignmentRow.arrived_at,
    transportStartedAt: assignmentRow.transport_started_at,
    destinationFacilityId: assignmentRow.destination_facility_id,
    completedAt: assignmentRow.completed_at, isManualOverride: assignmentRow.is_manual_override,
    assignedByUserId: assignmentRow.assigned_by_user_id,
  });
  const vehicleRow = await q.one<Row>(`
    SELECT v.*, l.lat location_lat, l.lng location_lng, l.heading, l.speed_kmh, l.recorded_at
    FROM vehicles v LEFT JOIN vehicle_current_location l ON l.vehicle_id = v.id WHERE v.id = ?
  `, [assignment.vehicleId]);
  const assignedVehicle = vehicleRow ? zVehicleWithLocation.parse({
    id: vehicleRow.id, orgId: vehicleRow.org_id, callsign: vehicleRow.callsign,
    status: vehicleRow.status, capabilityLevel: vehicleRow.capability_level,
    capabilities: JSON.parse(String(vehicleRow.capabilities)), homeBaseId: vehicleRow.home_base_id,
    operatingZoneId: vehicleRow.operating_zone_id, currentAssignmentId: vehicleRow.current_assignment_id,
    activeShiftId: vehicleRow.active_shift_id, isSimulated: vehicleRow.is_simulated, updatedAt: vehicleRow.updated_at,
    location: vehicleRow.recorded_at == null ? null : {
      vehicleId: vehicleRow.id, lat: vehicleRow.location_lat, lng: vehicleRow.location_lng,
      heading: vehicleRow.heading, speedKmh: vehicleRow.speed_kmh, recordedAt: vehicleRow.recorded_at,
    },
    isStale: vehicleRow.recorded_at == null || Date.now() - (vehicleRow.recorded_at as number) > 60_000,
  }) : null;
  const etaRow = await q.one<Row & { eta_seconds: number }>(`
    SELECT dc.eta_seconds
    FROM dispatch_candidates dc
    JOIN dispatch_runs dr ON dr.id = dc.dispatch_run_id
    WHERE dr.incident_id = ? AND dc.vehicle_id = ? AND dc.excluded_reason IS NULL
    ORDER BY dr.created_at DESC, dr.id DESC
    LIMIT 1
  `, [incidentId, assignment.vehicleId]);
  return {
    assignment,
    assignedVehicle,
    liveEtaSeconds: etaRow?.eta_seconds ?? null,
  };
}
