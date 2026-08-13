import { assertVehicleTransition, type VehicleWithLocation } from '@dispatch/contracts';
import { getDatabase, newId, type SqliteDatabase } from '@/src/server/infra/db';
import { bus } from '@/src/server/infra/bus';
import { HttpError } from '@/src/server/infra/errors';
import { findActiveAssignment, findVehicle, setVehicleState } from './repository';

export function startShift(
  vehicleId: string,
  crewUserIds: readonly string[] = [],
  db: SqliteDatabase = getDatabase(),
): VehicleWithLocation {
  const now = Date.now();
  const shiftId = newId(now);
  db.transaction(() => {
    const vehicle = findVehicle(db, vehicleId);
    if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'Vehículo no encontrado');
    assertVehicleTransition(vehicle.status, 'AVAILABLE');
    if (vehicle.activeShiftId) throw new HttpError(409, 'INVALID_TRANSITION', 'El vehículo ya tiene un turno activo');
    db.prepare(`INSERT INTO shifts (id, vehicle_id, crew_user_ids, started_at, ended_at)
      VALUES (?, ?, ?, ?, NULL)`).run(shiftId, vehicleId, JSON.stringify(crewUserIds), now);
    setVehicleState(db, vehicleId, 'AVAILABLE', now, shiftId);
  })();
  const updated = findVehicle(db, vehicleId)!;
  bus.emit('vehicle:updated', updated);
  return updated;
}

export function endShift(vehicleId: string, db: SqliteDatabase = getDatabase()): VehicleWithLocation {
  const now = Date.now();
  db.transaction(() => {
    const vehicle = findVehicle(db, vehicleId);
    if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'Vehículo no encontrado');
    if (!vehicle.activeShiftId) throw new HttpError(409, 'INVALID_TRANSITION', 'El vehículo no tiene un turno activo');
    if (findActiveAssignment(db, vehicleId)) {
      throw new HttpError(409, 'VEHICLE_UNAVAILABLE', 'No se puede cerrar turno con una asignación activa');
    }
    assertVehicleTransition(vehicle.status, 'OFFLINE');
    db.prepare('UPDATE shifts SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
      .run(now, vehicle.activeShiftId);
    setVehicleState(db, vehicleId, 'OFFLINE', now, null);
  })();
  const updated = findVehicle(db, vehicleId)!;
  bus.emit('vehicle:updated', updated);
  return updated;
}
