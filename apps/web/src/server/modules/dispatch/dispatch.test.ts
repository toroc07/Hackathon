import { beforeEach, describe, expect, it } from 'vitest';
import { totalScore } from '@dispatch/contracts';
import { isLocalPostgres } from '../../test-helpers';
import { db, type Queryable } from '@dispatch/db';
import { dropAll, runMigrations } from '@dispatch/db/migrations';
import { runDispatch, assignVehicle, expireStaleOffers } from './index';
import { calculateCandidates } from './internal/candidates';
import { scoreCandidate } from './internal/scoring';
import type { IncidentRow, VehicleRow, ZoneRow } from './internal/types';

async function resetDatabase(): Promise<Queryable> {
  await dropAll();
  await runMigrations();
  const q = db();
  await q.run(`INSERT INTO organizations (id, name, type, created_at) VALUES (?, ?, ?, ?)`, [
    'org', 'EMS', 'EMS', 0,
  ]);
  return q;
}

async function addZone(q: Queryable, id: string, name: string, target = 1, weight = 1): Promise<void> {
  await q.run(`INSERT INTO zones
    (id, name, polygon, center_lat, center_lng, target_coverage_units, population_weight)
    VALUES (?, ?, '[]', 10.4, -75.5, ?, ?)`, [id, name, target, weight]);
}

async function addIncident(
  q: Queryable,
  id: string,
  lat: number,
  lng: number,
  zone: string,
  required = 'ALS',
): Promise<void> {
  await q.run(`INSERT INTO incidents
    (id, code, status, type, lat, lng, required_capability, zone_id, created_at)
    VALUES (?, ?, 'OPEN', 'TRAFFIC_ACCIDENT', ?, ?, ?, ?, 0)`, [
    id, `INC-${id}`, lat, lng, required, zone,
  ]);
}

async function addVehicle(q: Queryable, input: {
  id: string; callsign: string; level?: string; zone: string;
  lat: number; lng: number; recordedAt: number;
}): Promise<void> {
  await q.run(`INSERT INTO vehicles
    (id, org_id, callsign, status, capability_level, capabilities, operating_zone_id, is_simulated, updated_at)
    VALUES (?, 'org', ?, 'AVAILABLE', ?, '[]', ?, ?, ?)`, [
    input.id, input.callsign, input.level ?? 'ALS', input.zone, true, input.recordedAt,
  ]);
  await q.run(`INSERT INTO vehicle_current_location (vehicle_id, lat, lng, recorded_at)
    VALUES (?, ?, ?, ?)`, [input.id, input.lat, input.lng, input.recordedAt]);
}

describe.skipIf(!isLocalPostgres())('dispatch engine', () => {
  let q: Queryable;

  beforeEach(async () => {
    q = await resetDatabase();
  });

  it('permite exactamente un ganador entre 50 intentos por el mismo vehículo', async () => {
    await addZone(q, 'z', 'Centro');
    await addIncident(q, 'i', 10.4, -75.5, 'z');
    await addVehicle(q, { id: 'v', callsign: 'A17', zone: 'z', lat: 10.4, lng: -75.5, recordedAt: 1_000 });

    const attempts = await Promise.allSettled(Array.from({ length: 50 }, (_, index) =>
      assignVehicle({ incidentId: 'i', vehicleId: 'v', idempotencyKey: `attempt-${index}`, now: 1_000 + index })));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(49);
    expect(await q.one(`SELECT COUNT(*)::INTEGER AS count FROM assignments`)).toEqual({ count: 1 });
  });

  it('mantiene la propiedad total_score = suma de los seis términos', () => {
    for (let index = 0; index < 500; index += 1) {
      const etaSeconds = index % 1_201;
      const terms = scoreCandidate({
        etaSeconds,
        vehicleCapability: ['MEDICAL_MOTO', 'BLS', 'ALS', 'RESCUE'][index % 4] as 'MEDICAL_MOTO' | 'BLS' | 'ALS' | 'RESCUE',
        requiredCapability: 'BLS',
        coverage: { penalty: (index % 3) * 120, deficitBefore: 0, deficitAfter: index % 3, isLastAvailableUnit: false, zoneName: 'z' },
        recentJobs: index % 7,
        locationAgeMs: (index % 12) * 30_000,
        outsideOperatingZone: index % 2 === 0,
      });
      expect(terms.totalScore).toBe(totalScore({ etaSeconds, ...terms }));
    }
  });

  it('escenario B: después de reservar A17 en Bocagrande, Crespo elige otra unidad y lo explica', async () => {
    await addZone(q, 'boca', 'Bocagrande', 1);
    await addZone(q, 'crespo', 'Crespo', 1);
    await addZone(q, 'centro', 'Centro', 1);
    await addIncident(q, 'boca-1', 10.4006, -75.556, 'boca');
    await addIncident(q, 'crespo-2', 10.445, -75.513, 'crespo');
    await addVehicle(q, { id: 'a17', callsign: 'A17', zone: 'boca', lat: 10.4007, lng: -75.556, recordedAt: 1_000_000 });
    await addVehicle(q, { id: 'a12', callsign: 'A12', zone: 'centro', lat: 10.438, lng: -75.52, recordedAt: 1_000_000 });
    await addVehicle(q, { id: 'a16', callsign: 'A16', zone: 'crespo', lat: 10.445, lng: -75.513, recordedAt: 1_000_000 });

    const first = await runDispatch('boca-1', { mode: 'AUTO_ASSIGN' }, { now: 1_000_000 });
    expect(first.assignment?.vehicleId).toBe('a17');
    const second = await runDispatch('crespo-2', { mode: 'AUTO_ASSIGN' }, { now: 1_030_000 });
    expect(second.assignment?.vehicleId).not.toBe('a17');
    expect(second.excluded.find((candidate) => candidate.vehicleId === 'a17')?.explanation).toContain('oferta activa');
    expect(second.candidates[0]?.explanation).toMatch(/ETA .* = /);
  });

  it('excluye BLS insuficiente y GPS con más de cinco minutos', () => {
    const incident: IncidentRow = { id: 'i', status: 'OPEN', lat: 10.4, lng: -75.5, zone_id: 'z', required_capability: 'ALS' };
    const zone: ZoneRow = { id: 'z', name: 'Centro', target_coverage_units: 1, population_weight: 1, available_units: 2 };
    const vehicles: VehicleRow[] = [
      { id: 'bls', callsign: 'B01', status: 'AVAILABLE', capability_level: 'BLS', operating_zone_id: 'z', current_assignment_id: null, lat: 10.4, lng: -75.5, recorded_at: 1_000_000, recent_jobs: 0 },
      { id: 'stale', callsign: 'A21', status: 'AVAILABLE', capability_level: 'ALS', operating_zone_id: 'z', current_assignment_id: null, lat: 10.4, lng: -75.5, recorded_at: 699_999, recent_jobs: 0 },
    ];
    const result = calculateCandidates(incident, vehicles, [zone], 1_000_000);
    expect(result.excluded.map((candidate) => candidate.excludedReason)).toEqual(['INSUFFICIENT_CAPABILITY', 'LOCATION_TOO_STALE']);
  });

  it('expira la oferta, libera el recurso y re-despacha excluyendo al que no respondió', async () => {
    await addZone(q, 'z', 'Centro', 1);
    await addIncident(q, 'i', 10.4, -75.5, 'z');
    await addVehicle(q, { id: 'v1', callsign: 'A01', zone: 'z', lat: 10.4, lng: -75.5, recordedAt: 1_000 });
    await addVehicle(q, { id: 'v2', callsign: 'A02', zone: 'z', lat: 10.401, lng: -75.501, recordedAt: 1_000 });
    const initial = await runDispatch('i', { mode: 'AUTO_ASSIGN' }, { now: 1_000 });
    expect(initial.assignment?.vehicleId).toBe('v1');

    const swept = await expireStaleOffers({ now: 31_001 });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.assignment.status).toBe('EXPIRED');
    expect(swept[0]?.dispatch.assignment?.vehicleId).toBe('v2');
    expect(await q.one(`SELECT status FROM incidents WHERE id = ?`, ['i'])).toEqual({ status: 'ASSIGNING' });
    expect(await q.one(`SELECT status FROM vehicles WHERE id = ?`, ['v1'])).toEqual({ status: 'AVAILABLE' });
  });
});
