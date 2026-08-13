import type { VehicleLocation } from '@dispatch/contracts';
import { getDatabase, newId, type SqliteDatabase } from '@/src/server/infra/db';
import { HttpError } from '@/src/server/infra/errors';
import { bus } from '@/src/server/infra/bus';
import { findVehicle, vehicleExists } from './repository';

export interface LocationPosition {
  lat: number;
  lng: number;
  heading?: number;
  speedKmh?: number;
  recordedAt: number;
}

export function recordLocations(
  vehicleId: string,
  positions: readonly LocationPosition[],
  db: SqliteDatabase = getDatabase(),
): VehicleLocation[] {
  if (!vehicleExists(db, vehicleId)) {
    throw new HttpError(404, 'NOT_FOUND', 'Vehículo no encontrado');
  }

  const insertHistory = db.prepare(`
    INSERT INTO vehicle_locations (id, vehicle_id, lat, lng, heading, speed_kmh, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertCurrent = db.prepare(`
    INSERT INTO vehicle_current_location (vehicle_id, lat, lng, heading, speed_kmh, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(vehicle_id) DO UPDATE SET
      lat = excluded.lat,
      lng = excluded.lng,
      heading = excluded.heading,
      speed_kmh = excluded.speed_kmh,
      recorded_at = excluded.recorded_at
    WHERE excluded.recorded_at >= vehicle_current_location.recorded_at
  `);
  const recorded = positions.map((position) => ({
    vehicleId,
    lat: position.lat,
    lng: position.lng,
    heading: position.heading ?? null,
    speedKmh: position.speedKmh ?? null,
    recordedAt: position.recordedAt,
  }));

  db.transaction(() => {
    for (const position of recorded) {
      insertHistory.run(
        newId(), vehicleId, position.lat, position.lng, position.heading,
        position.speedKmh, position.recordedAt,
      );
      upsertCurrent.run(
        vehicleId, position.lat, position.lng, position.heading,
        position.speedKmh, position.recordedAt,
      );
    }
    db.prepare('UPDATE vehicles SET updated_at = ? WHERE id = ?').run(Date.now(), vehicleId);
  })();

  const vehicle = findVehicle(db, vehicleId);
  if (vehicle?.location) bus.emit('vehicle:location', vehicle.location);
  if (vehicle) bus.emit('vehicle:updated', vehicle);
  return recorded;
}
