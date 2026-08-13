import { MOCK_FACILITIES, MOCK_ZONES } from '@dispatch/contracts';
import { getDatabase, runMigrations, type SqliteDatabase } from '../src/index.js';

const VEHICLE_COUNT = 30;
const LEVELS = ['BLS', 'BLS', 'ALS', 'MEDICAL_MOTO', 'RESCUE'] as const;

export function seedDatabase(connection: SqliteDatabase = getDatabase()): void {
  runMigrations(connection);

  // Las POSICIONES son deterministas (se derivan geométricamente del índice),
  // pero los TIMESTAMPS deben ser frescos en cada seed.
  //
  // Con una constante fija aquí, el GPS sembrado nacía con meses de antigüedad
  // y el motor excluía toda la flota por LOCATION_TOO_STALE (corte: 5 min):
  // cada incidente terminaba en NO_RESOURCE y la demo mostraba cero unidades
  // disponibles. La demo sigue siendo reproducible; lo que se mueve es el reloj.
  const SEED_NOW = Date.now();

  connection.transaction(() => {
    connection.prepare(`INSERT INTO organizations (id, name, type, created_at)
      VALUES ('org-ems', 'Red de Emergencias Cartagena', 'EMS', ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type`).run(SEED_NOW);

    const upsertUser = connection.prepare(`INSERT INTO users (id, org_id, role, name, phone, created_at)
      VALUES (?, 'org-ems', ?, ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET role = excluded.role, name = excluded.name`);
    upsertUser.run('user-dispatcher', 'DISPATCHER', 'Operador Demo', SEED_NOW);
    upsertUser.run('user-responder', 'RESPONDER', 'Tripulación Demo', SEED_NOW);
    upsertUser.run('user-admin', 'ADMIN', 'Administrador Demo', SEED_NOW);

    const upsertFacility = connection.prepare(`INSERT INTO facilities
      (id, name, type, lat, lng, capabilities, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
        lat = excluded.lat, lng = excluded.lng, capabilities = excluded.capabilities`);
    for (const facility of MOCK_FACILITIES) {
      upsertFacility.run(facility.id, facility.name, facility.type, facility.lat, facility.lng, JSON.stringify(facility.capabilities), SEED_NOW);
    }

    const upsertZone = connection.prepare(`INSERT INTO zones
      (id, name, polygon, center_lat, center_lng, target_coverage_units, population_weight)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, polygon = excluded.polygon,
        center_lat = excluded.center_lat, center_lng = excluded.center_lng,
        target_coverage_units = excluded.target_coverage_units, population_weight = excluded.population_weight`);
    for (const zone of MOCK_ZONES) {
      upsertZone.run(zone.id, zone.name, JSON.stringify(zone.polygon), zone.centerLat, zone.centerLng, zone.targetCoverageUnits, zone.populationWeight);
    }

    const seededIds = Array.from({ length: VEHICLE_COUNT }, (_, index) => `seed-vehicle-${String(index + 1).padStart(2, '0')}`);
    const placeholders = seededIds.map(() => '?').join(',');
    connection.prepare(`DELETE FROM vehicle_current_location WHERE vehicle_id IN (${placeholders})`).run(...seededIds);
    connection.prepare(`DELETE FROM vehicle_locations WHERE vehicle_id IN (${placeholders})`).run(...seededIds);
    connection.prepare(`DELETE FROM shifts WHERE vehicle_id IN (${placeholders})`).run(...seededIds);
    connection.prepare(`DELETE FROM vehicles WHERE id IN (${placeholders})`).run(...seededIds);

    const insertVehicle = connection.prepare(`INSERT INTO vehicles
      (id, org_id, callsign, status, capability_level, capabilities, home_base_id,
       operating_zone_id, current_assignment_id, active_shift_id, is_simulated, updated_at)
      VALUES (?, 'org-ems', ?, 'AVAILABLE', ?, ?, ?, ?, NULL, ?, 1, ?)`);
    const insertShift = connection.prepare(`INSERT INTO shifts (id, vehicle_id, crew_user_ids, started_at, ended_at)
      VALUES (?, ?, '["user-responder"]', ?, NULL)`);
    const insertLocation = connection.prepare(`INSERT INTO vehicle_locations
      (id, vehicle_id, lat, lng, heading, speed_kmh, recorded_at) VALUES (?, ?, ?, ?, ?, 0, ?)`);
    const insertCurrentLocation = connection.prepare(`INSERT INTO vehicle_current_location
      (vehicle_id, lat, lng, heading, speed_kmh, recorded_at) VALUES (?, ?, ?, ?, 0, ?)`);

    for (let index = 0; index < VEHICLE_COUNT; index += 1) {
      const ordinal = index + 1;
      const id = seededIds[index]!;
      const zone = MOCK_ZONES[index % MOCK_ZONES.length]!;
      const ring = Math.floor(index / MOCK_ZONES.length) + 1;
      const angle = ((index * 137.5) * Math.PI) / 180;
      const lat = zone.centerLat + Math.sin(angle) * ring * 0.0012;
      const lng = zone.centerLng + Math.cos(angle) * ring * 0.0012;
      const level = LEVELS[index % LEVELS.length]!;
      const shiftId = `seed-shift-${String(ordinal).padStart(2, '0')}`;
      const capabilities = level === 'ALS' ? ['OXYGEN', 'DEFIB', 'MONITOR'] : level === 'RESCUE' ? ['EXTRICATION', 'OXYGEN'] : ['OXYGEN'];
      const homeBaseId = zone.id === 'z-crespo' || zone.id === 'z-boquilla' ? 'f-base-crespo' : 'f-base-centro';
      const heading = (index * 47) % 360;

      insertVehicle.run(id, `A${String(ordinal).padStart(2, '0')}`, level, JSON.stringify(capabilities), homeBaseId, zone.id, shiftId, SEED_NOW);
      insertShift.run(shiftId, id, SEED_NOW - 3_600_000);
      insertLocation.run(`seed-location-${String(ordinal).padStart(2, '0')}`, id, lat, lng, heading, SEED_NOW);
      insertCurrentLocation.run(id, lat, lng, heading, SEED_NOW);
    }
  })();
}

const isEntrypoint = process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/[A-Za-z]:/, (match) => match.slice(1)).replaceAll('/', '\\').toLowerCase() === process.argv[1].toLowerCase();
if (isEntrypoint) {
  seedDatabase();
  console.log(`Seed listo: ${VEHICLE_COUNT} vehículos en ${MOCK_ZONES.length} zonas de Cartagena.`);
}
