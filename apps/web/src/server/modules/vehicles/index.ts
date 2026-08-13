import { assertVehicleTransition, type RegisterVehicleRequest, type VehicleStatus, type VehicleWithLocation } from '@dispatch/contracts';
import { db, newId, tx, type Queryable } from '@/src/server/infra/db';
import { bus } from '@/src/server/infra/bus';
import { HttpError } from '@/src/server/infra/errors';
import { recordLocations, type LocationPosition } from './internal/locations';
import { endShift, startShift } from './internal/shifts';
import {
  findActiveAssignment,
  findAvailableVehicles,
  findVehicle,
  findVehicleByCallsign,
  findVehicleByPlate,
  findVehicles,
  insertVehicle,
  setVehicleState,
  type ActiveAssignmentContext,
} from './internal/repository';

/** org_id fijo: la demo es de una sola operadora. */
const ORG_ID = 'org-ems';

/** Ambulancia "universal" de la demo — no hay login de unidad ni selector
 *  (§ remodel: un solo panel de responder recibe todo, sin importar el tipo
 *  de emergencia). RESCUE es el nivel más alto de packages/db/seed
 *  (`meetsCapability` compara por rango): así nunca queda excluida del
 *  despacho por capacidad insuficiente, sea cual sea el incidente. Su turno y
 *  ubicación ya vienen activos desde el seed. */
export const UNIVERSAL_VEHICLE_ID = 'seed-vehicle-05';

/** Alta de una ambulancia nueva — placa + unidad + hospital (§33). Arranca
 *  OFFLINE; el responder la ve en el selector e inicia turno como cualquier
 *  otra unidad de la flota sembrada. */
export async function registerVehicle(input: RegisterVehicleRequest): Promise<{ vehicleId: string; callsign: string }> {
  const existing = await findVehicleByPlate(input.plate);
  if (existing) throw new HttpError(409, 'VALIDATION_FAILED', `La placa ${input.plate} ya está registrada`);
  if (await findVehicleByCallsign(input.callsign)) {
    throw new HttpError(409, 'VALIDATION_FAILED', `Ya existe una unidad con el número ${input.callsign}`);
  }
  const now = Date.now();
  const id = newId(now);
  await insertVehicle({
    id, orgId: ORG_ID, callsign: input.callsign, capabilityLevel: input.capabilityLevel,
    plate: input.plate, hospitalFacilityId: input.hospitalFacilityId, createdAt: now,
  });
  return { vehicleId: id, callsign: input.callsign };
}

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
