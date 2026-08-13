import type { VehicleLocation } from '@dispatch/contracts';
import { db, newId, tx, type Queryable } from '@/src/server/infra/db';
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

export async function recordLocations(
  vehicleId: string,
  positions: readonly LocationPosition[],
  q?: Queryable,
): Promise<VehicleLocation[]> {
  const connection = q ?? db();
  if (!await vehicleExists(vehicleId, connection)) {
    throw new HttpError(404, 'NOT_FOUND', 'Vehículo no encontrado');
  }

  const recorded = positions.map((position) => ({
    vehicleId,
    lat: position.lat,
    lng: position.lng,
    heading: position.heading ?? null,
    speedKmh: position.speedKmh ?? null,
    recordedAt: position.recordedAt,
  }));

  const write = async (t: Queryable) => {
    for (const position of recorded) {
      await t.run(`INSERT INTO vehicle_locations
        (id, vehicle_id, lat, lng, heading, speed_kmh, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        newId(), vehicleId, position.lat, position.lng, position.heading,
        position.speedKmh, position.recordedAt,
      ]);
      await t.run(`INSERT INTO vehicle_current_location
        (vehicle_id, lat, lng, heading, speed_kmh, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (vehicle_id) DO UPDATE SET
          lat = EXCLUDED.lat,
          lng = EXCLUDED.lng,
          heading = EXCLUDED.heading,
          speed_kmh = EXCLUDED.speed_kmh,
          recorded_at = EXCLUDED.recorded_at
        WHERE EXCLUDED.recorded_at >= vehicle_current_location.recorded_at`, [
        vehicleId, position.lat, position.lng, position.heading,
        position.speedKmh, position.recordedAt,
      ]);
    }
    await t.run('UPDATE vehicles SET updated_at = ? WHERE id = ?', [Date.now(), vehicleId]);
  };
  if (q) await write(q);
  else await tx(write);

  const vehicle = await findVehicle(vehicleId, connection);
  if (vehicle?.location) bus.emit('vehicle:location', vehicle.location);
  if (vehicle) bus.emit('vehicle:updated', vehicle);
  return recorded;
}
