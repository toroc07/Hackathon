import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '@dispatch/contracts';
import { isLocalPostgres } from '../../test-helpers';
import { closePool, db } from '@dispatch/db';
import { dropAll, runMigrations } from '@dispatch/db/migrations';
import { seedDatabase } from '../../../../../../packages/db/seed/index';
import {
  acceptAssignment,
  assignVehicle,
  completeAssignment,
  markArrived,
  markEnRoute,
  startTransport,
} from '../dispatch';
import { endShift, getVehicle, recordLocations, setStatus, startShift } from './index';

beforeEach(async () => {
  await dropAll();
  await runMigrations();
  await seedDatabase();
});

afterAll(async () => {
  await closePool();
});

async function createIncident(id: string, now: number): Promise<void> {
  await db().run(`INSERT INTO incidents
    (id, code, status, priority, type, lat, lng, address, patient_count,
     required_capability, created_at)
    VALUES (?, ?, 'OPEN', 'P2', 'TRAFFIC_ACCIDENT', 10.4006, -75.556,
      'Av. San Martín, Bocagrande', 1, 'BLS', ?)`, [id, `INC-${id}`, now]);
}

describe.skipIf(!isLocalPostgres())('dominio de vehículos', () => {
  it('completa turno, asignación y cierre con evento en cada paso', async () => {
    const vehicleId = 'seed-vehicle-01';
    await endShift(vehicleId);
    expect((await getVehicle(vehicleId)).status).toBe('OFFLINE');
    await startShift(vehicleId, ['user-responder']);

    const now = 1_800_000_000_000;
    await createIncident('cycle', now);
    const offered = await assignVehicle({ incidentId: 'cycle', vehicleId, now });
    await acceptAssignment(offered.id, { now: now + 1_000 });
    await markEnRoute(offered.id, { now: now + 2_000 });
    await markArrived(offered.id, { now: now + 3_000 });
    await startTransport(offered.id, 'f-bocagrande', { now: now + 4_000 });
    const completed = await completeAssignment(offered.id, { now: now + 5_000 });

    expect(completed.status).toBe('COMPLETED');
    expect(await getVehicle(vehicleId)).toMatchObject({ status: 'AVAILABLE', currentAssignmentId: null });
    const events = await db().many<{ event_type: string }>(
      'SELECT event_type FROM incident_events WHERE incident_id = ? ORDER BY created_at',
      ['cycle'],
    );
    expect(events.map((event) => event.event_type)).toEqual([
      'VEHICLE_ASSIGNED', 'ASSIGNMENT_ACCEPTED', 'VEHICLE_EN_ROUTE',
      'ARRIVED_ON_SCENE', 'TRANSPORT_STARTED', 'INCIDENT_COMPLETED',
    ]);
  });

  it('rechaza transiciones inválidas sin mutar el vehículo', async () => {
    const vehicleId = 'seed-vehicle-02';
    await expect(setStatus(vehicleId, 'ON_SCENE')).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await getVehicle(vehicleId)).status).toBe('AVAILABLE');
  });

  it('mantiene current_location igual a la muestra histórica más reciente', async () => {
    const vehicleId = 'seed-vehicle-03';
    const positions = [
      { lat: 10.41, lng: -75.53, heading: 20, speedKmh: 18, recordedAt: 1_800_000_001_000 },
      { lat: 10.42, lng: -75.52, heading: 25, speedKmh: 22, recordedAt: 1_800_000_004_000 },
    ];
    await recordLocations(vehicleId, positions);
    const current = await db().one(
      'SELECT lat, lng, heading, speed_kmh, recorded_at FROM vehicle_current_location WHERE vehicle_id = ?',
      [vehicleId],
    );
    const latest = await db().one(
      'SELECT lat, lng, heading, speed_kmh, recorded_at FROM vehicle_locations WHERE vehicle_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1',
      [vehicleId],
    );
    expect(current).toEqual(latest);
  });

  it('conserva timestamps originales en un lote acumulado offline', async () => {
    const vehicleId = 'seed-vehicle-04';
    const timestamps = [1_800_000_003_000, 1_800_000_006_000, 1_800_000_009_000];
    await recordLocations(vehicleId, timestamps.map((recordedAt, index) => ({
      lat: 10.4 + index * 0.001,
      lng: -75.55 + index * 0.001,
      recordedAt,
    })));
    const rows = await db().many<{ recorded_at: number }>(
      'SELECT recorded_at FROM vehicle_locations WHERE vehicle_id = ? AND recorded_at >= ? ORDER BY recorded_at',
      [vehicleId, timestamps[0]],
    );
    expect(rows.map((row) => row.recorded_at)).toEqual(timestamps);
  });
});
