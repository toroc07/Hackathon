/**
 * CONTRACTS — triage por reglas explícitas.
 * ⚠ §24 DEL BRIEF: la prioridad de una emergencia NUNCA la determina un LLM.
 *
 * Un LLM puede SUGERIR el `IncidentType` a partir de texto libre (eso es
 * clasificación de lenguaje, reversible y de bajo riesgo). La PRIORIDAD sale
 * de esta tabla, y un operador humano siempre puede sobrescribirla.
 *
 * Toda fila de esta tabla debe tener un test.
 */

import type { IncidentType, IncidentPriority, CapabilityLevel } from './enums.js';

export interface TriageSignals {
  patientCount: number;
  /** Marcadas explícitamente por el reporter con botones, no inferidas de texto. */
  unconscious?: boolean;
  notBreathing?: boolean;
  severeBleeding?: boolean;
  trapped?: boolean;
}

export interface TriageResult {
  priority: IncidentPriority;
  requiredCapability: CapabilityLevel;
  /** Regla que disparó. Se persiste: la decisión tiene que ser rastreable. */
  ruleId: string;
  rationale: string;
}

interface TriageRule {
  id: string;
  matches: (type: IncidentType, s: TriageSignals) => boolean;
  priority: IncidentPriority;
  capability: CapabilityLevel;
  rationale: string;
}

/**
 * Orden importa: gana la PRIMERA que hace match. Las más críticas van arriba.
 */
export const TRIAGE_RULES: readonly TriageRule[] = [
  {
    id: 'R01_NOT_BREATHING',
    matches: (_t, s) => s.notBreathing === true,
    priority: 'P1',
    capability: 'ALS',
    rationale: 'Vía aérea comprometida — requiere soporte vital avanzado',
  },
  {
    id: 'R02_CARDIAC',
    matches: (t) => t === 'CARDIAC',
    priority: 'P1',
    capability: 'ALS',
    rationale: 'Evento cardíaco — requiere desfibrilación y soporte avanzado',
  },
  {
    id: 'R03_UNCONSCIOUS',
    matches: (_t, s) => s.unconscious === true,
    priority: 'P1',
    capability: 'ALS',
    rationale: 'Paciente inconsciente — causa desconocida, se asume grave',
  },
  {
    id: 'R04_SEVERE_BLEEDING',
    matches: (_t, s) => s.severeBleeding === true,
    priority: 'P1',
    capability: 'ALS',
    rationale: 'Hemorragia severa — riesgo de shock hipovolémico',
  },
  {
    id: 'R05_TRAPPED',
    matches: (_t, s) => s.trapped === true,
    priority: 'P1',
    capability: 'RESCUE',
    rationale: 'Persona atrapada — requiere unidad de rescate con extricación',
  },
  {
    id: 'R06_MASS_CASUALTY',
    matches: (_t, s) => s.patientCount >= 3,
    priority: 'P1',
    capability: 'ALS',
    rationale: 'Incidente con múltiples víctimas (≥3)',
  },
  {
    id: 'R07_TRAFFIC_MULTI',
    matches: (t, s) => t === 'TRAFFIC_ACCIDENT' && s.patientCount >= 2,
    priority: 'P2',
    capability: 'ALS',
    rationale: 'Accidente vehicular con más de un paciente',
  },
  {
    id: 'R08_TRAFFIC',
    matches: (t) => t === 'TRAFFIC_ACCIDENT',
    priority: 'P2',
    capability: 'BLS',
    rationale: 'Accidente vehicular — mecanismo de trauma significativo',
  },
  {
    id: 'R09_RESPIRATORY',
    matches: (t) => t === 'RESPIRATORY',
    priority: 'P2',
    capability: 'ALS',
    rationale: 'Dificultad respiratoria — puede escalar rápido',
  },
  {
    id: 'R10_OBSTETRIC',
    matches: (t) => t === 'OBSTETRIC',
    priority: 'P2',
    capability: 'ALS',
    rationale: 'Emergencia obstétrica',
  },
  {
    id: 'R11_TRAUMA',
    matches: (t) => t === 'TRAUMA',
    priority: 'P2',
    capability: 'BLS',
    rationale: 'Trauma sin señales críticas marcadas',
  },
  {
    id: 'R12_FALL',
    matches: (t) => t === 'FALL',
    priority: 'P3',
    capability: 'BLS',
    rationale: 'Caída sin pérdida de conciencia reportada',
  },
  {
    id: 'R99_DEFAULT',
    matches: () => true,
    priority: 'P3',
    capability: 'BLS',
    rationale: 'Sin señales críticas — evaluación en sitio',
  },
];

export function triage(type: IncidentType, signals: TriageSignals): TriageResult {
  const rule = TRIAGE_RULES.find((r) => r.matches(type, signals));
  // R99 siempre hace match, así que esto no puede ser undefined.
  if (!rule) throw new Error('TRIAGE_RULES sin regla por defecto — bug de configuración');
  return {
    priority: rule.priority,
    requiredCapability: rule.capability,
    ruleId: rule.id,
    rationale: rule.rationale,
  };
}
