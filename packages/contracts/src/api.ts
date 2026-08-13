/**
 * CONTRACTS — contrato de API. ⚠ CONGELADO tras W0.
 *
 * Modificaciones al contrato original del brief (§15), ya comunicadas:
 *  1. POST /incidents SIEMPRE crea un report; a veces además un incident.
 *     Responde con honestidad si hubo merge.
 *  2. POST /incidents/:id/dispatch unifica recomendar / auto-asignar / override.
 *  3. GET /incidents/:id/candidates devuelve el desglose completo persistido.
 *  4. Todo POST mutador acepta header `Idempotency-Key`.
 *  5. Los clientes envían ACCIONES, nunca `status`.
 *  6. POST /incidents/transcribe (§31, aditivo): transcribe una nota de voz
 *     del reporter y la estructura en un reporte sugerido. No persiste nada.
 */

import { z } from 'zod';
import {
  zIncident, zIncidentReport, zVehicleWithLocation, zDispatchCandidate,
  zAssignment, zIncidentEvent, zZoneCoverage, zCartagenaPoint, zIncidentType,
  zRejectReason, zId, zCapabilityLevel, zVehicleStatus,
} from './models.js';

// ─── INCIDENTES ─────────────────────────────────────────────────────────────

/** POST /incidents — entrada del ciudadano. Sin login (§2A). */
export const zCreateIncidentRequest = z.object({
  type: zIncidentType,
  point: zCartagenaPoint,
  accuracyM: z.number().optional(),
  description: z.string().max(1000).optional(),
  patientCount: z.number().int().min(0).max(50).default(1),
  reporterContact: z.string().max(120).optional(),
  source: z.enum(['WEB', 'WHATSAPP', 'CALL', 'SIM']).default('WEB'),
  // Señales marcadas con botones explícitos, NO inferidas de texto libre (§24).
  signals: z.object({
    unconscious: z.boolean().optional(),
    notBreathing: z.boolean().optional(),
    severeBleeding: z.boolean().optional(),
    trapped: z.boolean().optional(),
  }).optional(),
});
export type CreateIncidentRequest = z.infer<typeof zCreateIncidentRequest>;

export const zCreateIncidentResponse = z.object({
  incident: zIncident,
  report: zIncidentReport,
  /** true ⇒ se pegó a un incidente existente. La UI dice "ya hay unidad en camino". */
  wasMerged: z.boolean(),
  mergedIntoIncidentId: zId.nullable(),
});
export type CreateIncidentResponse = z.infer<typeof zCreateIncidentResponse>;

/**
 * POST /incidents/transcribe — audio → transcripción + reporte (§31).
 * Multipart, no JSON: el body es un campo `audio` (blob). No crea nada por sí
 * solo; el cliente sigue confirmando cada campo antes de POST /incidents.
 * La IA solo captura y estructura (README "La capa de IA y su límite"): todo
 * en `report` es una SUGERENCIA editable. Nunca decide prioridad médica (§24)
 * ni marca las señales críticas (unconscious/notBreathing/severeBleeding/
 * trapped) — esas siempre son botones explícitos del humano.
 */
export const zTranscribeAudioResponse = z.object({
  /** Salida literal del speech-to-text, sin tocar. */
  transcript: z.string().max(1000),
  report: z.object({
    /** 1-2 frases en español que resumen qué está pasando, para prellenar `description`. */
    summary: z.string().max(1000),
    suggestedType: zIncidentType.nullable(),
    suggestedPatientCount: z.number().int().min(0).max(50).nullable(),
  }),
});
export type TranscribeAudioResponse = z.infer<typeof zTranscribeAudioResponse>;

/** GET /incidents/:id */
export const zIncidentDetailResponse = z.object({
  incident: zIncident,
  reports: z.array(zIncidentReport),
  assignment: zAssignment.nullable(),
  assignedVehicle: zVehicleWithLocation.nullable(),
  events: z.array(zIncidentEvent),
  /** ETA en vivo hacia el incidente, si hay unidad en ruta. */
  liveEtaSeconds: z.number().int().nullable(),
});
export type IncidentDetailResponse = z.infer<typeof zIncidentDetailResponse>;

/** PATCH /incidents/:id — solo campos operativos. NUNCA `status`. */
export const zUpdateIncidentRequest = z.object({
  patientCount: z.number().int().min(0).max(50).optional(),
  address: z.string().optional(),
  requiredCapability: zCapabilityLevel.optional(),
  priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional(),   // override del operador
  cancel: z.object({ reason: z.string() }).optional(),
});

// ─── VEHÍCULOS ──────────────────────────────────────────────────────────────

/** POST /vehicles/:id/location — acepta lote para reconexión offline. */
export const zPostLocationRequest = z.object({
  positions: z.array(z.object({
    lat: z.number(),
    lng: z.number(),
    heading: z.number().optional(),
    speedKmh: z.number().optional(),
    /** Timestamp del DISPOSITIVO, no del servidor. Ver skill de A2. */
    recordedAt: z.number().int(),
  })).min(1).max(100),
});

/** PATCH /vehicles/:id/status — solo transiciones válidas de la máquina. */
export const zUpdateVehicleStatusRequest = z.object({
  status: zVehicleStatus,
});

export const zStartShiftRequest = z.object({
  crewUserIds: z.array(zId).default([]),
});

// ─── DESPACHO ───────────────────────────────────────────────────────────────

/** POST /incidents/:id/dispatch — recomienda, auto-asigna u override. */
export const zDispatchRequest = z.object({
  mode: z.enum(['RECOMMEND', 'AUTO_ASSIGN']).default('RECOMMEND'),
  /** Si viene, se salta la recomendación. Queda auditado como MANUAL_OVERRIDE. */
  overrideVehicleId: zId.optional(),
  /** Excluidos por reintento: quien rechazó o dejó expirar. */
  excludeVehicleIds: z.array(zId).optional(),
});
export type DispatchRequest = z.infer<typeof zDispatchRequest>;

export const zDispatchResponse = z.object({
  dispatchRunId: zId,
  incidentId: zId,
  strategyVersion: z.string(),
  candidates: z.array(zDispatchCandidate),
  excluded: z.array(zDispatchCandidate),
  recommendedVehicleId: zId.nullable(),
  /** Por qué el #1 le ganó al #2. Generada por REGLA (§24). */
  recommendationRationale: z.string().nullable(),
  /** Presente solo si mode=AUTO_ASSIGN u overrideVehicleId y la toma tuvo éxito. */
  assignment: zAssignment.nullable(),
  durationMs: z.number().int(),
  computedAt: z.number().int(),
});
export type DispatchResponse = z.infer<typeof zDispatchResponse>;

// ─── ASIGNACIONES (acciones del responder) ──────────────────────────────────

export const zAcceptAssignmentRequest = z.object({}).optional();
export const zRejectAssignmentRequest = z.object({
  reason: zRejectReason,
  note: z.string().max(300).optional(),
});
export const zTransportRequest = z.object({
  destinationFacilityId: zId,
});
export const zCompleteAssignmentRequest = z.object({
  note: z.string().max(500).optional(),
}).optional();

// ─── COMMAND CENTER ─────────────────────────────────────────────────────────

export const zOperationsSnapshot = z.object({
  incidents: z.array(zIncident),
  vehicles: z.array(zVehicleWithLocation),
  coverage: z.array(zZoneCoverage),
  metrics: z.object({
    openIncidents: z.number().int(),
    availableUnits: z.number().int(),
    dispatchedUnits: z.number().int(),
    avgAssignmentSeconds: z.number().nullable(),
    avgResponseSeconds: z.number().nullable(),
    /** La métrica que prueba la tesis del producto (§23). */
    duplicateReportsMerged: z.number().int(),
    coverageHealth: z.enum(['HEALTHY', 'DEGRADED', 'CRITICAL']),
  }),
  serverTime: z.number().int(),
});
export type OperationsSnapshot = z.infer<typeof zOperationsSnapshot>;

// ─── ERRORES ────────────────────────────────────────────────────────────────

/** Forma única de error. Los 4 dominios la usan; el frontend la maneja una vez. */
export const zApiError = z.object({
  error: z.object({
    code: z.enum([
      'VALIDATION_FAILED',
      'NOT_FOUND',
      'INVALID_TRANSITION',      // 409
      'VEHICLE_UNAVAILABLE',     // 409 — perdiste la carrera de asignación
      'ASSIGNMENT_EXPIRED',      // 409
      'NO_RESOURCE',
      'FORBIDDEN',
      'INTERNAL',
    ]),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof zApiError>;

// ─── REALTIME (SSE) ─────────────────────────────────────────────────────────

/** Topics del bus. A5 es dueño del transporte; los dominios solo emiten. */
export const SSE_TOPICS = [
  'incident:created', 'incident:updated', 'incident:merged',
  'vehicle:updated', 'vehicle:location',
  'dispatch:candidates', 'assignment:updated',
  'coverage:updated',
] as const;
export type SseTopic = (typeof SSE_TOPICS)[number];

export const zSseEnvelope = z.object({
  topic: z.enum(SSE_TOPICS),
  payload: z.unknown(),
  emittedAt: z.number().int(),
});
export type SseEnvelope = z.infer<typeof zSseEnvelope>;
