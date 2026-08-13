/**
 * CONTRACTS — enums canónicos.
 * ⚠ CONGELADO tras W0. Cambios solo vía Athena (§28 del brief).
 * Toda ampliación debe comunicarse a los 5 agentes antes de mergear.
 */

export const INCIDENT_STATUS = [
  'REPORTED',     // entró un reporte, aún sin validar
  'VALIDATING',   // deduplicación / triage por regla
  'OPEN',         // confirmado, esperando recurso
  'ASSIGNING',    // motor corriendo / oferta enviada
  'ASSIGNED',     // unidad aceptó
  'EN_ROUTE',
  'ON_SCENE',
  'TRANSPORTING',
  'COMPLETED',
  'CANCELLED',
  'DUPLICATE',    // fusionado en otro incidente
  'NO_RESOURCE',  // sin unidad disponible
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUS)[number];

export const VEHICLE_STATUS = [
  'OFFLINE',        // sin turno
  'AVAILABLE',      // en turno, libre
  'RESERVED',       // oferta enviada, esperando respuesta — NO reasignable
  'ASSIGNED',       // aceptó, aún no arranca
  'EN_ROUTE',
  'ON_SCENE',
  'TRANSPORTING',
  'UNAVAILABLE',    // en turno pero no despachable (descanso, reabastecimiento)
  'OUT_OF_SERVICE', // avería
] as const;
export type VehicleStatus = (typeof VEHICLE_STATUS)[number];

export const ASSIGNMENT_STATUS = [
  'OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED',
  'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING', 'COMPLETED', 'CANCELLED',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUS)[number];

/** Estados en los que una asignación ocupa al vehículo. Base de los índices únicos. */
export const ACTIVE_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  'OFFERED', 'ACCEPTED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING',
];

/** Estados en los que un vehículo NO puede recibir otra oferta. */
export const BUSY_VEHICLE_STATUSES: readonly VehicleStatus[] = [
  'RESERVED', 'ASSIGNED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING',
];

/**
 * Prioridad. §24: NUNCA la determina un LLM. Se deriva de reglas explícitas
 * (ver packages/contracts/src/triage.ts) o la fija un operador humano.
 */
export const INCIDENT_PRIORITY = ['P1', 'P2', 'P3', 'P4'] as const;
export type IncidentPriority = (typeof INCIDENT_PRIORITY)[number];

export const INCIDENT_TYPE = [
  'TRAFFIC_ACCIDENT', 'CARDIAC', 'UNCONSCIOUS', 'FALL',
  'TRAUMA', 'RESPIRATORY', 'OBSTETRIC', 'OTHER',
] as const;
export type IncidentType = (typeof INCIDENT_TYPE)[number];

/** Nivel del vehículo. Orden ascendente = mayor capacidad. */
export const CAPABILITY_LEVEL = ['MEDICAL_MOTO', 'BLS', 'ALS', 'RESCUE'] as const;
export type CapabilityLevel = (typeof CAPABILITY_LEVEL)[number];
export const CAPABILITY_RANK: Record<CapabilityLevel, number> = {
  MEDICAL_MOTO: 0, BLS: 1, ALS: 2, RESCUE: 3,
};

export const REPORT_SOURCE = ['WEB', 'WHATSAPP', 'CALL', 'SIM'] as const;
export type ReportSource = (typeof REPORT_SOURCE)[number];

export const ETA_SOURCE = ['HAVERSINE_URBAN', 'ROUTED', 'CACHED'] as const;
export type EtaSource = (typeof ETA_SOURCE)[number];

/** §12 — auditoría. Append-only. */
export const INCIDENT_EVENT_TYPE = [
  'INCIDENT_CREATED', 'REPORT_ADDED', 'REPORT_MERGED', 'PRIORITY_SET',
  'DISPATCH_STARTED', 'CANDIDATES_CALCULATED', 'VEHICLE_RECOMMENDED',
  'VEHICLE_ASSIGNED', 'ASSIGNMENT_ACCEPTED', 'ASSIGNMENT_REJECTED',
  'ASSIGNMENT_EXPIRED', 'VEHICLE_EN_ROUTE', 'ARRIVED_ON_SCENE',
  'TRANSPORT_STARTED', 'INCIDENT_COMPLETED', 'INCIDENT_CANCELLED',
  'MANUAL_OVERRIDE', 'NO_RESOURCE_AVAILABLE',
] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPE)[number];

export const ACTOR_TYPE = ['REPORTER', 'DISPATCHER', 'RESPONDER', 'SYSTEM', 'SIMULATOR'] as const;
export type ActorType = (typeof ACTOR_TYPE)[number];

export const REJECT_REASON = [
  'MECHANICAL', 'CREW_UNAVAILABLE', 'ALREADY_COMMITTED', 'UNSAFE_ACCESS', 'OTHER',
] as const;
export type RejectReason = (typeof REJECT_REASON)[number];
