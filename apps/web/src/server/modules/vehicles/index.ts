import { assertVehicleTransition, type VehicleStatus, type VehicleWithLocation } from '@dispatch/contracts';
import { getDatabase, type SqliteDatabase } from '@/src/server/infra/db';
import { bus } from '@/src/server/infra/bus';
import { HttpError } from '@/src/server/infra/errors';
import { recordLocations, type LocationPosition } from './internal/locations';
import { endShift, startShift } from './internal/shifts';
import {
  findActiveAssignment,
  findAvailableVehicles,
  findVehicle,
  findVehicles,
  setVehicleState,
  type ActiveAssignmentContext,
} from './internal/repository';

export function listVehicles(options: { availableOnly?: boolean } = {}, db: SqliteDatabase = getDatabase()): VehicleWithLocation[] {
  return options.availableOnly ? findAvailableVehicles(db) : findVehicles(db);
}

export function getVehicle(vehicleId: string, db: SqliteDatabase = getDatabase()): VehicleWithLocation {
  const vehicle = findVehicle(db, vehicleId);
  if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'Vehículo no encontrado');
  return vehicle;
}

export function setStatus(vehicleId: string, status: VehicleStatus, db: SqliteDatabase = getDatabase()): VehicleWithLocation {
  const updated = db.transaction(() => {
    const vehicle = getVehicle(vehicleId, db);
    assertVehicleTransition(vehicle.status, status);
    if (['RESERVED', 'ASSIGNED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING'].includes(status)) {
      throw new HttpError(409, 'INVALID_TRANSITION', 'Los estados de servicio sólo los deriva una acción de asignación');
    }
    if (status === 'OFFLINE' && vehicle.activeShiftId) {
      throw new HttpError(409, 'INVALID_TRANSITION', 'Cierra el turno para pasar el vehículo a OFFLINE');
    }
    if (status === 'AVAILABLE' && findActiveAssignment(db, vehicleId)) {
      throw new HttpError(409, 'VEHICLE_UNAVAILABLE', 'El vehículo conserva una asignación activa');
    }
    setVehicleState(db, vehicleId, status, Date.now());
    return getVehicle(vehicleId, db);
  })();
  bus.emit('vehicle:updated', updated);
  return updated;
}

export function getActiveAssignmentForVehicle(
  vehicleId: string,
  db: SqliteDatabase = getDatabase(),
): ActiveAssignmentContext | null {
  getVehicle(vehicleId, db);
  return findActiveAssignment(db, vehicleId);
}

export { startShift, endShift, recordLocations };
export type { LocationPosition, ActiveAssignmentContext };
