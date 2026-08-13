import {
  assertAssignmentTransition,
  assertIncidentTransition,
  assertVehicleTransition,
  type Assignment,
  type IncidentStatus,
  type VehicleStatus,
} from '@dispatch/contracts';
import { db, newId, tx, type Queryable } from '@/src/server/infra/db';
import { mapAssignment, type AssignmentRow } from './assignment';

interface ExpiredRow extends AssignmentRow {
  incident_status: IncidentStatus;
  vehicle_status: VehicleStatus;
}

export interface ExpireOffersOptions {
  now?: number;
  q?: Queryable;
}

export async function expireOffers(options: ExpireOffersOptions = {}): Promise<Assignment[]> {
  const q = options.q ?? db();
  const now = options.now ?? Date.now();
  const stale = await q.many<ExpiredRow>(`SELECT a.*, i.status AS incident_status, v.status AS vehicle_status
    FROM assignments a JOIN incidents i ON i.id = a.incident_id JOIN vehicles v ON v.id = a.vehicle_id
    WHERE a.status = 'OFFERED' AND a.expires_at < ? ORDER BY a.expires_at`, [now]);
  const expired: Assignment[] = [];

  for (const row of stale) {
    const operation = async (t: Queryable): Promise<Assignment | null> => {
      const changed = await t.one<AssignmentRow>(`UPDATE assignments SET status = 'EXPIRED', responded_at = ?
        WHERE id = ? AND status = 'OFFERED' AND expires_at < ? RETURNING *`, [now, row.id, now]);
      if (!changed) return null;
      assertAssignmentTransition(row.status, 'EXPIRED');
      assertIncidentTransition(row.incident_status, 'OPEN');
      assertVehicleTransition(row.vehicle_status, 'AVAILABLE');
      await t.run(`UPDATE vehicles SET status = 'AVAILABLE', current_assignment_id = NULL, updated_at = ?
        WHERE id = ? AND current_assignment_id = ?`, [now, row.vehicle_id, row.id]);
      await t.run(`UPDATE incidents SET status = 'OPEN' WHERE id = ? AND status = 'ASSIGNING'`, [row.incident_id]);
      await t.run(`INSERT INTO incident_events
        (id, incident_id, event_type, actor_type, actor_id, metadata, created_at)
        VALUES (?, ?, 'ASSIGNMENT_EXPIRED', 'SYSTEM', NULL, ?, ?)`, [
        newId(now), row.incident_id, JSON.stringify({ assignmentId: row.id, vehicleId: row.vehicle_id }), now,
      ]);
      return mapAssignment(changed);
    };
    const result = await (options.q ? operation(options.q) : tx(operation));
    if (result) expired.push(result);
  }
  return expired;
}
