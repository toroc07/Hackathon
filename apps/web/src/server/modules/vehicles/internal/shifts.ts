import { assertVehicleTransition, type VehicleWithLocation } from '@dispatch/contracts';
import { newId, tx, type Queryable } from '@/src/server/infra/db';
import { bus } from '@/src/server/infra/bus';
import { HttpError } from '@/src/server/infra/errors';
import { findActiveAssignment, findVehicle, setVehicleState } from './repository';

export async function startShift(
  vehicleId: string,
  crewUserIds: readonly string[] = [],
  q?: Queryable,
): Promise<VehicleWithLocation> {
  const now = Date.now();
  const shiftId = newId(now);
  const update = async (t: Queryable) => {
    const vehicle = await findVehicle(vehicleId, t);
    if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'Vehículo no encontrado');
    assertVehicleTransition(vehicle.status, 'AVAILABLE');
    if (vehicle.activeShiftId) throw new HttpError(409, 'INVALID_TRANSITION', 'El vehículo ya tiene un turno activo');
    await t.run(`INSERT INTO shifts (id, vehicle_id, crew_user_ids, started_at, ended_at)
      VALUES (?, ?, ?, ?, NULL)`, [shiftId, vehicleId, JSON.stringify(crewUserIds), now]);
    await setVehicleState(vehicleId, 'AVAILABLE', now, shiftId, t);
    return findVehicle(vehicleId, t);
  };
  const updated = q ? await update(q) : await tx(update);
  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Vehículo no encontrado');
  bus.emit('vehicle:updated', updated);
  return updated;
}

export async function endShift(vehicleId: string, q?: Queryable): Promise<VehicleWithLocation> {
  const now = Date.now();
  const update = async (t: Queryable) => {
    const vehicle = await findVehicle(vehicleId, t);
    if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'Vehículo no encontrado');
    if (!vehicle.activeShiftId) throw new HttpError(409, 'INVALID_TRANSITION', 'El vehículo no tiene un turno activo');
    if (await findActiveAssignment(vehicleId, t)) {
      throw new HttpError(409, 'VEHICLE_UNAVAILABLE', 'No se puede cerrar turno con una asignación activa');
    }
    assertVehicleTransition(vehicle.status, 'OFFLINE');
    await t.run('UPDATE shifts SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [now, vehicle.activeShiftId]);
    await setVehicleState(vehicleId, 'OFFLINE', now, null, t);
    return findVehicle(vehicleId, t);
  };
  const updated = q ? await update(q) : await tx(update);
  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Vehículo no encontrado');
  bus.emit('vehicle:updated', updated);
  return updated;
}
