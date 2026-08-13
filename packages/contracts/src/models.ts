/**
 * CONTRACTS — modelos de dominio (zod).
 * ⚠ CONGELADO tras W0. Cambios solo vía Athena.
 *
 * Un solo schema valida el request en el servidor Y tipa el cliente.
 * Una definición, cero drift entre frontend y backend (§14).
 */

import { z } from 'zod';
import {
  INCIDENT_STATUS, VEHICLE_STATUS, ASSIGNMENT_STATUS, INCIDENT_PRIORITY,
  INCIDENT_TYPE, CAPABILITY_LEVEL, REPORT_SOURCE, ETA_SOURCE,
  INCIDENT_EVENT_TYPE, ACTOR_TYPE, REJECT_REASON,
} from './enums.js';
import { CARTAGENA_BBOX } from './geo.js';

// ─── Primitivas ─────────────────────────────────────────────────────────────

export const zId = z.string().min(1);
/** Epoch en MILISEGUNDOS. Toda la app usa la misma unidad. */
export const zTimestamp = z.number().int().nonnegative();

export const zPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/** Para entradas del MVP: rechaza coordenadas fuera del área de operación.
 *  Atrapa lat/lng invertidos, que es el bug de geo más común. */
export const zCartagenaPoint = zPoint.refine(
  (p) =>
    p.lat >= CARTAGENA_BBOX.minLat && p.lat <= CARTAGENA_BBOX.maxLat &&
    p.lng >= CARTAGENA_BBOX.minLng && p.lng <= CARTAGENA_BBOX.maxLng,
  { message: 'Coordenada fuera del área de operación de Cartagena (¿lat/lng invertidos?)' },
);

export const zIncidentStatus = z.enum(INCIDENT_STATUS);
export const zVehicleStatus = z.enum(VEHICLE_STATUS);
export const zAssignmentStatus = z.enum(ASSIGNMENT_STATUS);
export const zIncidentPriority = z.enum(INCIDENT_PRIORITY);
export const zIncidentType = z.enum(INCIDENT_TYPE);
export const zCapabilityLevel = z.enum(CAPABILITY_LEVEL);
export const zReportSource = z.enum(REPORT_SOURCE);
export const zEtaSource = z.enum(ETA_SOURCE);
export const zIncidentEventType = z.enum(INCIDENT_EVENT_TYPE);
export const zActorType = z.enum(ACTOR_TYPE);
export const zRejectReason = z.enum(REJECT_REASON);

// ─── Incidentes ─────────────────────────────────────────────────────────────

export const zIncident = z.object({
  id: zId,
  code: z.string(),                       // 'INC-482'
  status: zIncidentStatus,
  priority: zIncidentPriority.nullable(),
  type: zIncidentType,
  lat: z.number(),
  lng: z.number(),
  address: z.string().nullable(),
  patientCount: z.number().int().min(0),
  requiredCapability: zCapabilityLevel.nullable(),
  zoneId: zId.nullable(),
  primaryReportId: zId.nullable(),
  mergedIntoIncidentId: zId.nullable(),
  createdAt: zTimestamp,
  closedAt: zTimestamp.nullable(),
});
export type Incident = z.infer<typeof zIncident>;

export const zIncidentReport = z.object({
  id: zId,
  incidentId: zId,
  source: zReportSource,
  reporterContact: z.string().nullable(),
  description: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  accuracyM: z.number().nullable(),
  wasMerged: z.boolean(),
  mergeConfidence: z.number().nullable(),
  mergeReason: z.string().nullable(),
  createdAt: zTimestamp,
});
export type IncidentReport = z.infer<typeof zIncidentReport>;

// ─── Vehículos ──────────────────────────────────────────────────────────────

export const zVehicle = z.object({
  id: zId,
  orgId: zId,
  callsign: z.string(),
  status: zVehicleStatus,
  capabilityLevel: zCapabilityLevel,
  capabilities: z.array(z.string()),
  homeBaseId: zId.nullable(),
  operatingZoneId: zId.nullable(),
  currentAssignmentId: zId.nullable(),
  activeShiftId: zId.nullable(),
  isSimulated: z.boolean(),
  updatedAt: zTimestamp,
});
export type Vehicle = z.infer<typeof zVehicle>;

export const zVehicleLocation = z.object({
  vehicleId: zId,
  lat: z.number(),
  lng: z.number(),
  heading: z.number().nullable(),
  speedKmh: z.number().nullable(),
  recordedAt: zTimestamp,
});
export type VehicleLocation = z.infer<typeof zVehicleLocation>;

/** Lo que consume el mapa: vehículo + su última posición. */
export const zVehicleWithLocation = zVehicle.extend({
  location: zVehicleLocation.nullable(),
  isStale: z.boolean(),
});
export type VehicleWithLocation = z.infer<typeof zVehicleWithLocation>;

// ─── Despacho ───────────────────────────────────────────────────────────────

export const zDispatchCandidate = z.object({
  vehicleId: zId,
  callsign: z.string(),
  rank: z.number().int().nullable(),
  etaSeconds: z.number().int(),
  distanceM: z.number().int(),
  straightLineM: z.number().int(),
  etaSource: zEtaSource,
  capabilityPenalty: z.number(),
  coveragePenalty: z.number(),
  workloadPenalty: z.number(),
  staleLocationPenalty: z.number(),
  operationalPenalty: z.number(),
  totalScore: z.number(),
  excludedReason: z.string().nullable(),
  explanation: z.string(),
});
export type DispatchCandidate = z.infer<typeof zDispatchCandidate>;

export const zAssignment = z.object({
  id: zId,
  incidentId: zId,
  vehicleId: zId,
  dispatchRunId: zId.nullable(),
  status: zAssignmentStatus,
  offeredAt: zTimestamp,
  expiresAt: zTimestamp,
  respondedAt: zTimestamp.nullable(),
  rejectReason: zRejectReason.nullable(),
  enRouteAt: zTimestamp.nullable(),
  arrivedAt: zTimestamp.nullable(),
  transportStartedAt: zTimestamp.nullable(),
  destinationFacilityId: zId.nullable(),
  completedAt: zTimestamp.nullable(),
  isManualOverride: z.boolean(),
  assignedByUserId: zId.nullable(),
});
export type Assignment = z.infer<typeof zAssignment>;

// ─── Auditoría / geografía ──────────────────────────────────────────────────

export const zIncidentEvent = z.object({
  id: zId,
  incidentId: zId,
  eventType: zIncidentEventType,
  actorType: zActorType,
  actorId: zId.nullable(),
  metadata: z.record(z.unknown()),
  createdAt: zTimestamp,
});
export type IncidentEvent = z.infer<typeof zIncidentEvent>;

export const zFacility = z.object({
  id: zId,
  name: z.string(),
  type: z.enum(['HOSPITAL', 'BASE', 'TRAUMA_CENTER']),
  lat: z.number(),
  lng: z.number(),
  capabilities: z.array(z.string()),
});
export type Facility = z.infer<typeof zFacility>;

export const zZone = z.object({
  id: zId,
  name: z.string(),
  polygon: z.array(z.tuple([z.number(), z.number()])),   // [[lat,lng],...]
  centerLat: z.number(),
  centerLng: z.number(),
  targetCoverageUnits: z.number().int(),
  populationWeight: z.number(),
});
export type Zone = z.infer<typeof zZone>;

/** Salud de cobertura por zona — lo pinta el Command Center. */
export const zZoneCoverage = z.object({
  zoneId: zId,
  zoneName: z.string(),
  availableUnits: z.number().int(),
  targetUnits: z.number().int(),
  deficit: z.number().int(),
  health: z.enum(['HEALTHY', 'DEGRADED', 'CRITICAL']),
});
export type ZoneCoverage = z.infer<typeof zZoneCoverage>;
