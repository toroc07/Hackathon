/**
 * CONTRACTS — máquinas de estado. ÚNICA fuente de verdad de las transiciones.
 * ⚠ CONGELADO tras W0.
 *
 * REGLA (§7, §10): ningún cliente envía un `status`. Los clientes disparan
 * ACCIONES (/accept, /arrive). El servidor deriva el estado y llama a
 * assertTransition() ANTES de escribir. Sin excepciones, en los 4 dominios.
 */

import type { IncidentStatus, VehicleStatus, AssignmentStatus } from './enums.js';

export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  REPORTED:     ['VALIDATING', 'DUPLICATE', 'CANCELLED'],
  VALIDATING:   ['OPEN', 'DUPLICATE', 'CANCELLED'],
  OPEN:         ['ASSIGNING', 'NO_RESOURCE', 'CANCELLED'],
  // vuelve a OPEN si la unidad rechaza o la oferta expira
  ASSIGNING:    ['ASSIGNED', 'OPEN', 'NO_RESOURCE', 'CANCELLED'],
  // vuelve a OPEN si hay reasignación
  ASSIGNED:     ['EN_ROUTE', 'OPEN', 'CANCELLED'],
  EN_ROUTE:     ['ON_SCENE', 'OPEN', 'CANCELLED'],
  ON_SCENE:     ['TRANSPORTING', 'COMPLETED'],
  TRANSPORTING: ['COMPLETED'],
  COMPLETED:    [],
  CANCELLED:    [],
  DUPLICATE:    [],
  NO_RESOURCE:  ['OPEN', 'CANCELLED'],  // reintento cuando se libera flota
};

export const VEHICLE_TRANSITIONS: Record<VehicleStatus, readonly VehicleStatus[]> = {
  OFFLINE:        ['AVAILABLE'],
  AVAILABLE:      ['RESERVED', 'UNAVAILABLE', 'OUT_OF_SERVICE', 'OFFLINE'],
  RESERVED:       ['ASSIGNED', 'AVAILABLE'],   // AVAILABLE si rechaza o expira
  ASSIGNED:       ['EN_ROUTE', 'AVAILABLE'],
  EN_ROUTE:       ['ON_SCENE', 'AVAILABLE'],   // AVAILABLE si lo reasignan
  ON_SCENE:       ['TRANSPORTING', 'AVAILABLE'],
  TRANSPORTING:   ['AVAILABLE'],
  UNAVAILABLE:    ['AVAILABLE', 'OFFLINE', 'OUT_OF_SERVICE'],
  OUT_OF_SERVICE: ['OFFLINE', 'AVAILABLE'],
};

export const ASSIGNMENT_TRANSITIONS: Record<AssignmentStatus, readonly AssignmentStatus[]> = {
  OFFERED:      ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  ACCEPTED:     ['EN_ROUTE', 'CANCELLED'],
  EN_ROUTE:     ['ON_SCENE', 'CANCELLED'],
  ON_SCENE:     ['TRANSPORTING', 'COMPLETED'],
  TRANSPORTING: ['COMPLETED'],
  REJECTED:     [],
  EXPIRED:      [],
  COMPLETED:    [],
  CANCELLED:    [],
};

export class InvalidTransitionError extends Error {
  readonly httpStatus = 409;
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Transición inválida en ${entity}: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

function assert<T extends string>(
  entity: string,
  table: Record<T, readonly T[]>,
  from: T,
  to: T,
): void {
  // Idempotencia: repetir el estado actual no es un error, es un no-op.
  if (from === to) return;
  if (!table[from]?.includes(to)) throw new InvalidTransitionError(entity, from, to);
}

export const assertIncidentTransition = (from: IncidentStatus, to: IncidentStatus) =>
  assert('incident', INCIDENT_TRANSITIONS, from, to);

export const assertVehicleTransition = (from: VehicleStatus, to: VehicleStatus) =>
  assert('vehicle', VEHICLE_TRANSITIONS, from, to);

export const assertAssignmentTransition = (from: AssignmentStatus, to: AssignmentStatus) =>
  assert('assignment', ASSIGNMENT_TRANSITIONS, from, to);

/** Para tests y para pintar la UI sin adivinar. */
export const canTransition = {
  incident: (f: IncidentStatus, t: IncidentStatus) => INCIDENT_TRANSITIONS[f].includes(t),
  vehicle: (f: VehicleStatus, t: VehicleStatus) => VEHICLE_TRANSITIONS[f].includes(t),
  assignment: (f: AssignmentStatus, t: AssignmentStatus) => ASSIGNMENT_TRANSITIONS[f].includes(t),
};
