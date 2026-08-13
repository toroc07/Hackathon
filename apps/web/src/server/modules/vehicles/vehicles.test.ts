import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '@dispatch/contracts';
import { runMigrations, type SqliteDatabase } from '@dispatch/db';
import { seedDatabase } from '../../../../../../packages/db/seed/index';
import {
  acceptAssignment,
  assignVehicle,
  completeAssignment,
  markArrived,
  markEnRoute,
  startTransport,
} from '../dispatch';
import { assignmentActionOutcome } from '../../../../app/responder/responderState';
import { endShift, getVehicle, recordLocations, setStatus, startShift } from './index';

let db: SqliteDatabase;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seedDatabase(db);
});

afterEach(() => db.close());

function createIncident(id: string, now: number): void {
  db.prepare(`INSERT INTO incidents
    (id, code, status, priority, type, lat, lng, address, patient_count,
     required_capability, created_at)
    VALUES (?, ?, 'OPEN', 'P2', 'TRAFFIC_ACCIDENT', 10.4006, -75.556,
      'Av. San Martín, Bocagrande', 1, 'BLS', ?)`)
    .run(id, `INC-${id}`, now);
}

describe('dominio de vehículos', () => {
  it('completa turno, asignación y cierre con evento en cada paso', () => {
    const vehicleId = 'seed-vehicle-01';
    endShift(vehicleId, db);
    expect(getVehicle(vehicleId, db).status).toBe('OFFLINE');
    startShift(vehicleId, ['user-responder'], db);

    const now = 1_800_000_000_000;
    createIncident('cycle', now);
    const offered = assignVehicle({ incidentId: 'cycle', vehicleId, now, database: db });
    acceptAssignment(offered.id, { now: now + 1_000, database: db });
    markEnRoute(offered.id, { now: now + 2_000, database: db });
    markArrived(offered.id, { now: now + 3_000, database: db });
    startTransport(offered.id, 'f-bocagrande', { now: now + 4_000, database: db });
    const completed = completeAssignment(offered.id, { now: now + 5_000, database: db });

    expect(completed.status).toBe('COMPLETED');
    expect(getVehicle(vehicleId, db)).toMatchObject({ status: 'AVAILABLE', currentAssignmentId: null });
    const events = db.prepare('SELECT event_type FROM incident_events WHERE incident_id = ? ORDER BY created_at').all('cycle') as Array<{ event_type: string }>;
    expect(events.map((event) => event.event_type)).toEqual([
      'VEHICLE_ASSIGNED', 'ASSIGNMENT_ACCEPTED', 'VEHICLE_EN_ROUTE',
      'ARRIVED_ON_SCENE', 'TRANSPORT_STARTED', 'INCIDENT_COMPLETED',
    ]);
  });

  it('rechaza transiciones inválidas sin mutar el vehículo', () => {
    const vehicleId = 'seed-vehicle-02';
    expect(() => setStatus(vehicleId, 'ON_SCENE', db)).toThrow(InvalidTransitionError);
    expect(getVehicle(vehicleId, db).status).toBe('AVAILABLE');
  });

  it('mantiene current_location igual a la muestra histórica más reciente', () => {
    const vehicleId = 'seed-vehicle-03';
    const positions = [
      { lat: 10.41, lng: -75.53, heading: 20, speedKmh: 18, recordedAt: 1_800_000_001_000 },
      { lat: 10.42, lng: -75.52, heading: 25, speedKmh: 22, recordedAt: 1_800_000_004_000 },
    ];
    recordLocations(vehicleId, positions, db);
    const current = db.prepare('SELECT lat, lng, heading, speed_kmh, recorded_at FROM vehicle_current_location WHERE vehicle_id = ?').get(vehicleId);
    const latest = db.prepare('SELECT lat, lng, heading, speed_kmh, recorded_at FROM vehicle_locations WHERE vehicle_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1').get(vehicleId);
    expect(current).toEqual(latest);
  });

  it('conserva timestamps originales en un lote acumulado offline', () => {
    const vehicleId = 'seed-vehicle-04';
    const timestamps = [1_800_000_003_000, 1_800_000_006_000, 1_800_000_009_000];
    recordLocations(vehicleId, timestamps.map((recordedAt, index) => ({
      lat: 10.4 + index * 0.001,
      lng: -75.55 + index * 0.001,
      recordedAt,
    })), db);
    const rows = db.prepare('SELECT recorded_at FROM vehicle_locations WHERE vehicle_id = ? AND recorded_at >= ? ORDER BY recorded_at')
      .all(vehicleId, timestamps[0]) as Array<{ recorded_at: number }>;
    expect(rows.map((row) => row.recorded_at)).toEqual(timestamps);
  });

  it('interpreta 409 como pérdida de oferta y obliga a descartar el estado optimista', () => {
    expect(assignmentActionOutcome(409)).toEqual({
      kind: 'conflict',
      message: 'Esta asignación ya no está disponible',
    });
    expect(assignmentActionOutcome(200)).toEqual({ kind: 'ok' });
  });
});
