import { assertAssignmentTransition, assertIncidentTransition, assertVehicleTransition, type Assignment } from '@dispatch/contracts';
import { newId } from '@/src/server/infra/db';
import { mapAssignment } from './assignment';
import { dispatchDatabase, type DispatchDataAccess } from './data';

interface ExpiredRow {
  id: string; incident_id: string; vehicle_id: string; status: 'OFFERED';
  incident_status: 'ASSIGNING'; vehicle_status: 'RESERVED';
  [key: string]: unknown;
}

export function expireOffers(options: { now?: number; database?: DispatchDataAccess } = {}): Assignment[] {
  const db = dispatchDatabase(options.database);
  const now = options.now ?? Date.now();
  const stale = db.prepare(`SELECT a.*, i.status AS incident_status, v.status AS vehicle_status
    FROM assignments a JOIN incidents i ON i.id = a.incident_id JOIN vehicles v ON v.id = a.vehicle_id
    WHERE a.status = 'OFFERED' AND a.expires_at < ? ORDER BY a.expires_at`).all(now) as unknown as ExpiredRow[];
  const expired: Assignment[] = [];
  for (const row of stale) {
    const result = db.transaction(() => {
      const changed = db.prepare(`UPDATE assignments SET status = 'EXPIRED', responded_at = ?
        WHERE id = ? AND status = 'OFFERED' AND expires_at < ?`).run(now, row.id, now);
      if (Number(changed.changes) === 0) return null;
      assertAssignmentTransition(row.status, 'EXPIRED');
      assertIncidentTransition(row.incident_status, 'OPEN');
      assertVehicleTransition(row.vehicle_status, 'AVAILABLE');
      db.prepare(`UPDATE vehicles SET status = 'AVAILABLE', current_assignment_id = NULL, updated_at = ? WHERE id = ? AND current_assignment_id = ?`).run(now, row.vehicle_id, row.id);
      db.prepare(`UPDATE incidents SET status = 'OPEN' WHERE id = ? AND status = 'ASSIGNING'`).run(row.incident_id);
      db.prepare(`INSERT INTO incident_events (id, incident_id, event_type, actor_type, actor_id, metadata, created_at)
        VALUES (?, ?, 'ASSIGNMENT_EXPIRED', 'SYSTEM', NULL, ?, ?)`)
        .run(newId(now), row.incident_id, JSON.stringify({ assignmentId: row.id, vehicleId: row.vehicle_id }), now);
      return mapAssignment(db.prepare('SELECT * FROM assignments WHERE id = ?').get(row.id) as never);
    }).immediate();
    if (result) expired.push(result);
  }
  return expired;
}
