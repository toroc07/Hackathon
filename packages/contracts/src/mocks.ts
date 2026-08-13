/**
 * CONTRACTS — fixtures válidos.
 *
 * ESTO ES LO QUE HACE POSIBLE EL PARALELISMO (§16).
 * Cada agente desarrolla contra estos datos mientras los otros módulos no
 * existen. Nadie inventa formas de datos propias; cuando el módulo real llega,
 * la UI ya está construida contra la forma correcta y no hay que reescribirla.
 *
 * Todo fixture pasa su schema zod (hay un test que lo verifica).
 */

import type {
  Incident, IncidentReport, VehicleWithLocation, DispatchCandidate,
  Assignment, IncidentEvent, Facility, Zone, ZoneCoverage,
} from './models.js';
import type { DispatchResponse, OperationsSnapshot } from './api.js';

/** Instante fijo. Fixtures deterministas: la demo se ensaya, no se sortea. */
export const MOCK_NOW = 1_776_000_000_000;

// ─── Geografía real de Cartagena ────────────────────────────────────────────

export const MOCK_ZONES: Zone[] = [
  { id: 'z-centro', name: 'Centro / Getsemaní', polygon: [[10.428, -75.552], [10.428, -75.540], [10.418, -75.540], [10.418, -75.552]], centerLat: 10.4231, centerLng: -75.5464, targetCoverageUnits: 2, populationWeight: 1.3 },
  { id: 'z-bocagrande', name: 'Bocagrande / Castillogrande', polygon: [[10.408, -75.565], [10.408, -75.550], [10.393, -75.550], [10.393, -75.565]], centerLat: 10.4006, centerLng: -75.5560, targetCoverageUnits: 2, populationWeight: 1.1 },
  { id: 'z-crespo', name: 'Crespo', polygon: [[10.452, -75.520], [10.452, -75.505], [10.437, -75.505], [10.437, -75.520]], centerLat: 10.4450, centerLng: -75.5130, targetCoverageUnits: 1, populationWeight: 1.0 },
  { id: 'z-manga', name: 'Manga', polygon: [[10.418, -75.540], [10.418, -75.525], [10.405, -75.525], [10.405, -75.540]], centerLat: 10.4115, centerLng: -75.5325, targetCoverageUnits: 1, populationWeight: 1.0 },
  { id: 'z-boquilla', name: 'La Boquilla', polygon: [[10.485, -75.495], [10.485, -75.475], [10.465, -75.475], [10.465, -75.495]], centerLat: 10.4750, centerLng: -75.4850, targetCoverageUnits: 1, populationWeight: 0.8 },
  { id: 'z-olaya', name: 'Olaya Herrera', polygon: [[10.435, -75.520], [10.435, -75.500], [10.415, -75.500], [10.415, -75.520]], centerLat: 10.4250, centerLng: -75.5100, targetCoverageUnits: 2, populationWeight: 1.4 },
];

export const MOCK_FACILITIES: Facility[] = [
  { id: 'f-serena', name: 'Hospital Serena del Mar', type: 'TRAUMA_CENTER', lat: 10.5069, lng: -75.4633, capabilities: ['TRAUMA', 'CARDIAC', 'SURGERY'] },
  { id: 'f-bocagrande', name: 'Hospital Bocagrande', type: 'HOSPITAL', lat: 10.3993, lng: -75.5556, capabilities: ['EMERGENCY', 'CARDIAC'] },
  { id: 'f-naval', name: 'Hospital Naval de Cartagena', type: 'HOSPITAL', lat: 10.3960, lng: -75.5514, capabilities: ['EMERGENCY', 'TRAUMA'] },
  { id: 'f-base-centro', name: 'Base Centro', type: 'BASE', lat: 10.4231, lng: -75.5464, capabilities: [] },
  { id: 'f-base-crespo', name: 'Base Crespo', type: 'BASE', lat: 10.4450, lng: -75.5130, capabilities: [] },
];

// ─── Vehículos ──────────────────────────────────────────────────────────────

function vehicle(
  id: string, callsign: string, status: VehicleWithLocation['status'],
  level: VehicleWithLocation['capabilityLevel'], zoneId: string,
  lat: number, lng: number, ageMs = 4_000,
): VehicleWithLocation {
  return {
    id, orgId: 'org-ems', callsign, status, capabilityLevel: level,
    capabilities: level === 'ALS' ? ['OXYGEN', 'DEFIB', 'MONITOR'] : ['OXYGEN'],
    homeBaseId: 'f-base-centro', operatingZoneId: zoneId,
    currentAssignmentId: null, activeShiftId: `shift-${id}`, isSimulated: true,
    updatedAt: MOCK_NOW - ageMs,
    location: { vehicleId: id, lat, lng, heading: 45, speedKmh: 0, recordedAt: MOCK_NOW - ageMs },
    isStale: ageMs > 60_000,
  };
}

export const MOCK_VEHICLES: VehicleWithLocation[] = [
  vehicle('v-a12', 'A12', 'AVAILABLE', 'ALS', 'z-centro', 10.4180, -75.5490),
  vehicle('v-a16', 'A16', 'AVAILABLE', 'ALS', 'z-crespo', 10.4450, -75.5130),
  vehicle('v-a17', 'A17', 'AVAILABLE', 'ALS', 'z-bocagrande', 10.4020, -75.5570),
  vehicle('v-a03', 'A03', 'AVAILABLE', 'BLS', 'z-manga', 10.4115, -75.5325),
  vehicle('v-a21', 'A21', 'AVAILABLE', 'ALS', 'z-olaya', 10.4250, -75.5100, 7 * 60_000), // GPS viejo
  vehicle('v-a08', 'A08', 'EN_ROUTE', 'BLS', 'z-boquilla', 10.4750, -75.4850),
  vehicle('v-m01', 'M01', 'AVAILABLE', 'MEDICAL_MOTO', 'z-centro', 10.4240, -75.5450),
  vehicle('v-r01', 'R01', 'AVAILABLE', 'RESCUE', 'z-centro', 10.4200, -75.5440),
];

// ─── Incidente y reportes (escenario §22: 4 reportes → 1 incidente) ─────────

export const MOCK_INCIDENT: Incident = {
  id: 'i-482', code: 'INC-482', status: 'OPEN', priority: 'P2',
  type: 'TRAFFIC_ACCIDENT', lat: 10.4006, lng: -75.5560,
  address: 'Av. San Martín con Cra. 3, Bocagrande',
  patientCount: 2, requiredCapability: 'ALS', zoneId: 'z-bocagrande',
  primaryReportId: 'r-1', mergedIntoIncidentId: null,
  createdAt: MOCK_NOW - 90_000, closedAt: null,
};

function report(id: string, lat: number, lng: number, offset: number, merged: boolean, reason: string | null): IncidentReport {
  return {
    id, incidentId: 'i-482', source: 'WEB', reporterContact: null,
    description: 'Choque entre dos carros, hay personas heridas',
    lat, lng, accuracyM: 25, wasMerged: merged,
    mergeConfidence: merged ? 0.94 : null, mergeReason: reason,
    createdAt: MOCK_NOW - 90_000 + offset,
  };
}

export const MOCK_REPORTS: IncidentReport[] = [
  report('r-1', 10.4006, -75.5560, 0, false, null),
  report('r-2', 10.4008, -75.5558, 12_000, true, 'A 28m y 12s del reporte primario, tipo compatible'),
  report('r-3', 10.4004, -75.5563, 31_000, true, 'A 41m y 31s del reporte primario, tipo compatible'),
  report('r-4', 10.4009, -75.5555, 48_000, true, 'A 63m y 48s del reporte primario, tipo compatible'),
];

// ─── Resultado del motor (el panel de candidatos de A4) ─────────────────────

function candidate(
  vehicleId: string, callsign: string, rank: number | null, eta: number,
  coverage: number, capability = 0, stale = 0, operational = 0,
  excluded: string | null = null, explanation = '',
): DispatchCandidate {
  return {
    vehicleId, callsign, rank, etaSeconds: eta,
    distanceM: Math.round((eta / 3600) * 40 * 1000), straightLineM: Math.round((eta / 3600) * 40 * 1000 / 1.35),
    etaSource: 'HAVERSINE_URBAN',
    capabilityPenalty: capability, coveragePenalty: coverage,
    workloadPenalty: 0, staleLocationPenalty: stale, operationalPenalty: operational,
    totalScore: eta + capability + coverage + stale + operational,
    excludedReason: excluded, explanation,
  };
}

export const MOCK_DISPATCH_RESPONSE: DispatchResponse = {
  dispatchRunId: 'dr-001', incidentId: 'i-482', strategyVersion: 'v1',
  candidates: [
    candidate('v-a12', 'A12', 1, 252, 20, 0, 0, 0, null, 'ETA 4m12s + cobertura 20s = 4m32s'),
    candidate('v-a16', 'A16', 2, 221, 120, 0, 0, 0, null, 'ETA 3m41s + cobertura 2m00s = 5m41s — única unidad libre en Crespo'),
    candidate('v-r01', 'R01', 3, 300, 20, 45, 0, 0, null, 'ETA 5m00s + capacidad 45s + cobertura 20s = 6m05s'),
  ],
  excluded: [
    candidate('v-a03', 'A03', null, 180, 0, 0, 0, 0, 'INSUFFICIENT_CAPABILITY', 'BLS no cubre el requisito ALS del incidente'),
    candidate('v-a21', 'A21', null, 260, 0, 0, 0, 0, 'LOCATION_TOO_STALE', 'Última posición GPS hace 7 min (corte: 5 min)'),
    candidate('v-a08', 'A08', null, 0, 0, 0, 0, 0, 'NOT_AVAILABLE', 'En ruta a otro incidente'),
  ],
  recommendedVehicleId: 'v-a12',
  recommendationRationale:
    'A16 llega 31s antes, pero es la única unidad libre en Crespo y sacarla deja esa zona sin cobertura ~12 min. Por eso se recomienda A12.',
  assignment: null,
  durationMs: 8,
  computedAt: MOCK_NOW,
};

export const MOCK_ASSIGNMENT: Assignment = {
  id: 'as-001', incidentId: 'i-482', vehicleId: 'v-a12', dispatchRunId: 'dr-001',
  status: 'OFFERED', offeredAt: MOCK_NOW, expiresAt: MOCK_NOW + 30_000,
  respondedAt: null, rejectReason: null, enRouteAt: null, arrivedAt: null,
  transportStartedAt: null, destinationFacilityId: null, completedAt: null,
  isManualOverride: false, assignedByUserId: null,
};

// ─── Timeline (§12) ─────────────────────────────────────────────────────────

function event(id: string, type: IncidentEvent['eventType'], actor: IncidentEvent['actorType'], offset: number, metadata: Record<string, unknown> = {}): IncidentEvent {
  return { id, incidentId: 'i-482', eventType: type, actorType: actor, actorId: null, metadata, createdAt: MOCK_NOW - 90_000 + offset };
}

export const MOCK_EVENTS: IncidentEvent[] = [
  event('e-1', 'INCIDENT_CREATED', 'REPORTER', 0, { code: 'INC-482' }),
  event('e-2', 'PRIORITY_SET', 'SYSTEM', 200, { priority: 'P2', ruleId: 'R07_TRAFFIC_MULTI' }),
  event('e-3', 'REPORT_MERGED', 'SYSTEM', 12_000, { reportId: 'r-2', confidence: 0.94 }),
  event('e-4', 'REPORT_MERGED', 'SYSTEM', 31_000, { reportId: 'r-3', confidence: 0.91 }),
  event('e-5', 'REPORT_MERGED', 'SYSTEM', 48_000, { reportId: 'r-4', confidence: 0.89 }),
  event('e-6', 'DISPATCH_STARTED', 'DISPATCHER', 60_000, { dispatchRunId: 'dr-001' }),
  event('e-7', 'CANDIDATES_CALCULATED', 'SYSTEM', 60_100, { candidates: 3, excluded: 3 }),
  event('e-8', 'VEHICLE_RECOMMENDED', 'SYSTEM', 60_150, { vehicleId: 'v-a12', score: 272 }),
];

// ─── Cobertura y snapshot ───────────────────────────────────────────────────

export const MOCK_COVERAGE: ZoneCoverage[] = [
  { zoneId: 'z-centro', zoneName: 'Centro / Getsemaní', availableUnits: 3, targetUnits: 2, deficit: 0, health: 'HEALTHY' },
  { zoneId: 'z-bocagrande', zoneName: 'Bocagrande / Castillogrande', availableUnits: 1, targetUnits: 2, deficit: 1, health: 'DEGRADED' },
  { zoneId: 'z-crespo', zoneName: 'Crespo', availableUnits: 1, targetUnits: 1, deficit: 0, health: 'HEALTHY' },
  { zoneId: 'z-manga', zoneName: 'Manga', availableUnits: 1, targetUnits: 1, deficit: 0, health: 'HEALTHY' },
  { zoneId: 'z-boquilla', zoneName: 'La Boquilla', availableUnits: 0, targetUnits: 1, deficit: 1, health: 'CRITICAL' },
  { zoneId: 'z-olaya', zoneName: 'Olaya Herrera', availableUnits: 1, targetUnits: 2, deficit: 1, health: 'DEGRADED' },
];

export const MOCK_SNAPSHOT: OperationsSnapshot = {
  incidents: [MOCK_INCIDENT],
  vehicles: MOCK_VEHICLES,
  coverage: MOCK_COVERAGE,
  metrics: {
    openIncidents: 1, availableUnits: 6, dispatchedUnits: 1,
    avgAssignmentSeconds: 42, avgResponseSeconds: 298,
    duplicateReportsMerged: 3, coverageHealth: 'DEGRADED',
  },
  serverTime: MOCK_NOW,
};
