import { assertVehicleTransition, type VehicleStatus, type VehicleWithLocation } from '@dispatch/contracts';
import { db, tx, type Queryable } from '@/src/server/infra/db';
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

export async function listVehicles(
  options: { availableOnly?: boolean } = {},
  q: Queryable = db(),
): Promise<VehicleWithLocation[]> {
  return options.availableOnly ? findAvailableVehicles(q) : findVehicles(undefined, q);
}

export async function getVehicle(vehicleId: string, q: Queryable = db()): Promise<VehicleWithLocation> {
  const vehicle = await findVehicle(vehicleId, q);
  if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'Vehículo no encontrado');
  return vehicle;
}

export async function setStatus(
  vehicleId: string,
  status: VehicleStatus,
  q?: Queryable,
): Promise<VehicleWithLocation> {
  const update = async (t: Queryable) => {
    const vehicle = await getVehicle(vehicleId, t);
    assertVehicleTransition(vehicle.status, status);
    if (['RESERVED', 'ASSIGNED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING'].includes(status)) {
      throw new HttpError(409, 'INVALID_TRANSITION', 'Los estados de servicio sólo los deriva una acción de asignación');
    }
    if (status === 'OFFLINE' && vehicle.activeShiftId) {
      throw new HttpError(409, 'INVALID_TRANSITION', 'Cierra el turno para pasar el vehículo a OFFLINE');
    }
    if (status === 'AVAILABLE' && await findActiveAssignment(vehicleId, t)) {
      throw new HttpError(409, 'VEHICLE_UNAVAILABLE', 'El vehículo conserva una asignación activa');
    }
    await setVehicleState(vehicleId, status, Date.now(), undefined, t);
    return getVehicle(vehicleId, t);
  };
  const updated = q ? await update(q) : await tx(update);
  bus.emit('vehicle:updated', updated);
  return updated;
}

export async function getActiveAssignmentForVehicle(
  vehicleId: string,
  q: Queryable = db(),
): Promise<ActiveAssignmentContext | null> {
  await getVehicle(vehicleId, q);
  return findActiveAssignment(vehicleId, q);
}

export { startShift, endShift, recordLocations };
export type { LocationPosition, ActiveAssignmentContext };
