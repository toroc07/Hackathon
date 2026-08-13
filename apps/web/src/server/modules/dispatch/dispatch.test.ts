import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { totalScore } from '@dispatch/contracts';
import { runDispatch, assignVehicle, expireStaleOffers } from './index';
import { calculateCandidates } from './internal/candidates';
import { scoreCandidate } from './internal/scoring';
import type { DispatchDataAccess } from './internal/data';
import type { IncidentRow, VehicleRow, ZoneRow } from './internal/types';

function database(): { raw: Database.Database; db: DispatchDataAccess } {
  const raw = new Database(':memory:');
  for (const name of ['001_init.sql', '002_constraints.sql', '040_dispatch_candidate_explanation.sql']) {
    raw.exec(readFileSync(new URL(`../../../../../../packages/db/migrations/${name}`, import.meta.url), 'utf8'));
  }
  raw.prepare(`INSERT INTO organizations (id, name, type, created_at) VALUES ('org', 'EMS', 'EMS', 0)`).run();
  return { raw, db: raw as unknown as DispatchDataAccess };
}

function addZone(raw: Database.Database, id: string, name: string, target = 1, weight = 1): void {
  raw.prepare(`INSERT INTO zones (id, name, polygon, center_lat, center_lng, target_coverage_units, population_weight)
    VALUES (?, ?, '[]', 10.4, -75.5, ?, ?)`).run(id, name, target, weight);
}

function addIncident(raw: Database.Database, id: string, lat: number, lng: number, zone: string, required = 'ALS'): void {
  raw.prepare(`INSERT INTO incidents (id, code, status, type, lat, lng, required_capability, zone_id, created_at)
    VALUES (?, ?, 'OPEN', 'TRAFFIC_ACCIDENT', ?, ?, ?, ?, 0)`).run(id, `INC-${id}`, lat, lng, required, zone);
}

function addVehicle(raw: Database.Database, input: { id: string; callsign: string; level?: string; zone: string; lat: number; lng: number; recordedAt: number }): void {
  raw.prepare(`INSERT INTO vehicles
    (id, org_id, callsign, status, capability_level, capabilities, operating_zone_id, is_simulated, updated_at)
    VALUES (?, 'org', ?, 'AVAILABLE', ?, '[]', ?, 1, ?)`)
    .run(input.id, input.callsign, input.level ?? 'ALS', input.zone, input.recordedAt);
  raw.prepare(`INSERT INTO vehicle_current_location (vehicle_id, lat, lng, recorded_at) VALUES (?, ?, ?, ?)`)
    .run(input.id, input.lat, input.lng, input.recordedAt);
}

describe('dispatch engine', () => {
  it('permite exactamente un ganador entre 50 intentos por el mismo vehículo', async () => {
    const { raw, db } = database();
    addZone(raw, 'z', 'Centro');
    addIncident(raw, 'i', 10.4, -75.5, 'z');
    addVehicle(raw, { id: 'v', callsign: 'A17', zone: 'z', lat: 10.4, lng: -75.5, recordedAt: 1_000 });

    const attempts = await Promise.allSettled(Array.from({ length: 50 }, (_, index) => Promise.resolve().then(() =>
      assignVehicle({ incidentId: 'i', vehicleId: 'v', idempotencyKey: `attempt-${index}`, now: 1_000 + index, database: db }))));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(49);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM assignments`).get()).toEqual({ count: 1 });
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

  it('escenario B: después de reservar A17 en Bocagrande, Crespo elige otra unidad y lo explica', () => {
    const { raw, db } = database();
    addZone(raw, 'boca', 'Bocagrande', 1);
    addZone(raw, 'crespo', 'Crespo', 1);
    addZone(raw, 'centro', 'Centro', 1);
    addIncident(raw, 'boca-1', 10.4006, -75.556, 'boca');
    addIncident(raw, 'crespo-2', 10.445, -75.513, 'crespo');
    addVehicle(raw, { id: 'a17', callsign: 'A17', zone: 'boca', lat: 10.4007, lng: -75.556, recordedAt: 1_000_000 });
    addVehicle(raw, { id: 'a12', callsign: 'A12', zone: 'centro', lat: 10.438, lng: -75.52, recordedAt: 1_000_000 });
    addVehicle(raw, { id: 'a16', callsign: 'A16', zone: 'crespo', lat: 10.445, lng: -75.513, recordedAt: 1_000_000 });

    const first = runDispatch('boca-1', { mode: 'AUTO_ASSIGN' }, { database: db, now: 1_000_000 });
    expect(first.assignment?.vehicleId).toBe('a17');
    const second = runDispatch('crespo-2', { mode: 'AUTO_ASSIGN' }, { database: db, now: 1_030_000 });
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

  it('expira la oferta, libera el recurso y re-despacha excluyendo al que no respondió', () => {
    const { raw, db } = database();
    addZone(raw, 'z', 'Centro', 1);
    addIncident(raw, 'i', 10.4, -75.5, 'z');
    addVehicle(raw, { id: 'v1', callsign: 'A01', zone: 'z', lat: 10.4, lng: -75.5, recordedAt: 1_000 });
    addVehicle(raw, { id: 'v2', callsign: 'A02', zone: 'z', lat: 10.401, lng: -75.501, recordedAt: 1_000 });
    const initial = runDispatch('i', { mode: 'AUTO_ASSIGN' }, { database: db, now: 1_000 });
    expect(initial.assignment?.vehicleId).toBe('v1');

    const swept = expireStaleOffers({ database: db, now: 31_001 });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.assignment.status).toBe('EXPIRED');
    expect(swept[0]?.dispatch.assignment?.vehicleId).toBe('v2');
    expect(raw.prepare(`SELECT status FROM incidents WHERE id = 'i'`).get()).toEqual({ status: 'ASSIGNING' });
    expect(raw.prepare(`SELECT status FROM vehicles WHERE id = 'v1'`).get()).toEqual({ status: 'AVAILABLE' });
  });
});
