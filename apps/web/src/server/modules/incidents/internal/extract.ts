/**
 * Extraccion de campos estructurados a partir del transcript.
 *
 * POR REGLAS, NO POR LLM. Tres razones, en orden de importancia:
 *
 *  1. Auditable. Un operador puede preguntar "¿por que marcaste esto como
 *     cardiaco?" y la respuesta es una regla con nombre, no un embedding.
 *  2. Determinista. La demo da el mismo resultado todas las veces.
 *  3. Sin dependencias. Funciona aunque no haya ninguna API key configurada,
 *     que es exactamente el escenario del dia del hackathon.
 *
 * Un LLM puede AFINAR esto despues (ver enrichWithModel), pero el camino
 * critico no depende de el. Y en ningun caso decide la PRIORIDAD: eso sale de
 * la tabla de triage, que recibe estas señales como entrada.
 */

import type { IncidentType, TranscriptionResult } from '@dispatch/contracts';

/** Normaliza para comparar: minusculas y sin tildes. Quien habla bajo estres
 *  no dicta con ortografia, y el transcriptor tampoco acentua de forma fiable. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

interface TypeRule {
  type: IncidentType;
  /** Se evaluan en orden: gana la primera con match. */
  patterns: RegExp[];
}

/**
 * Orden deliberado: lo mas especifico y mas grave primero. "choque con un
 * herido inconsciente" debe clasificar como accidente de transito (el
 * mecanismo), no como inconsciencia aislada — el mecanismo determina que
 * recurso enviar.
 */
const TYPE_RULES: readonly TypeRule[] = [
  {
    type: 'TRAFFIC_ACCIDENT',
    patterns: [
      /\b(choque|choco|chocaron|accidente de (transito|trafico)|colision|colisionaron)\b/,
      /\b(atropell(o|aron|ado|ada))\b/,
      /\b(volc(o|aron|ado)|se volteo)\b/,
      /\b(moto|carro|camion|bus|taxi|vehiculo)\b.*\b(choc|estrell|accident)/,
    ],
  },
  {
    type: 'CARDIAC',
    patterns: [
      /\b(infarto|paro cardiaco|ataque al corazon|del corazon)\b/,
      /\b(dolor|apreta|opresion)\b.*\b(pecho)\b/,
      /\b(pecho)\b.*\b(dolor|aprieta|duele)\b/,
    ],
  },
  {
    type: 'RESPIRATORY',
    patterns: [
      /\b(no puede respirar|le falta el aire|dificultad para respirar)\b/,
      /\b(asma|asfixi|ahog(o|ando|andose)|atragant)\b/,
    ],
  },
  {
    type: 'OBSTETRIC',
    patterns: [
      /\b(embarazada|parto|dando a luz|contracciones|rompio fuente)\b/,
    ],
  },
  {
    type: 'FALL',
    patterns: [
      /\b(se cayo|se callo|caida|cayo de|se resbalo|rodo por)\b/,
    ],
  },
  {
    type: 'UNCONSCIOUS',
    patterns: [
      /\b(inconsciente|desmay(o|ada|ado)|no responde|perdio el conocimiento)\b/,
      /\b(no reacciona|esta tirad(o|a) en el piso)\b/,
    ],
  },
  {
    type: 'TRAUMA',
    patterns: [
      /\b(apuñal|puñalada|balaz|dispar|herida de bala|cortad|machete)\b/,
      /\b(golpe|golpearon|herid|fractur|quemad)\b/,
    ],
  },
];

/** Señales criticas. Alimentan triage(), que decide la prioridad. */
const SIGNAL_RULES = {
  notBreathing: [
    /\b(no (esta )?respira(ndo)?|dejo de respirar|no respira)\b/,
    /\b(sin respiracion|no le sale el aire)\b/,
  ],
  unconscious: [
    /\b(inconsciente|no responde|no reacciona|desmay|perdio el conocimiento)\b/,
    /\b(esta como muert|no se mueve)\b/,
  ],
  severeBleeding: [
    /\b(sangra mucho|mucha sangre|hemorragia|sangrando much|no para de sangrar)\b/,
    /\b(esta lleno de sangre|perdiendo sangre)\b/,
  ],
  trapped: [
    /\b(atrapad|prensad|aprisionad|no puede salir|esta debajo del)\b/,
    /\b(quedo dentro del (carro|vehiculo|auto))\b/,
  ],
} as const;

/** Numeros hablados. La gente dice "dos heridos", no "2". */
const SPOKEN_NUMBERS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

/**
 * Cuenta de pacientes. Conservador a proposito: ante la duda devuelve null y
 * deja que el valor por defecto (1) aplique, en vez de inventar un numero que
 * dispararia una respuesta de incidente masivo.
 */
export function extractPatientCount(normalized: string): number | null {
  const victimWord = '(herid[oa]s?|lesionad[oa]s?|pacientes?|personas?|victimas?|gente)';

  const digits = normalized.match(new RegExp(`\\b(\\d{1,2})\\s+${victimWord}`));
  if (digits?.[1]) {
    const n = Number.parseInt(digits[1], 10);
    if (n >= 0 && n <= 50) return n;
  }

  const words = Object.keys(SPOKEN_NUMBERS).join('|');
  const spoken = normalized.match(new RegExp(`\\b(${words})\\s+${victimWord}`));
  if (spoken?.[1]) return SPOKEN_NUMBERS[spoken[1]] ?? null;

  // "hay varios heridos" / "un montón de gente" — plural sin numero.
  if (/\b(varios|varias|muchos|muchas|un monton|bastantes)\b/.test(normalized)) return 3;

  return null;
}

/** Referencia de ubicacion hablada. No sustituye al GPS; ayuda a confirmarlo. */
export function extractLocationHint(original: string, normalized: string): string | null {
  const match = normalized.match(
    /\b(?:en|frente a|al frente de|cerca de|por|sobre|en la|en el)\s+((?:la |el |los |las )?[a-z0-9ñ' ]{4,45})/,
  );
  if (!match?.[1]) return null;

  const start = normalized.indexOf(match[1]);
  const hint = original.slice(start, start + match[1].length).trim();
  return hint.length >= 4 ? hint : null;
}

export interface ExtractionOutput {
  suggestedType: IncidentType | null;
  suggestedPatientCount: number | null;
  signals: TranscriptionResult['signals'];
  locationHint: string | null;
  /** Reglas que dispararon. Se persiste para poder auditar la clasificacion. */
  matchedRules: string[];
}

export function extractFromTranscript(transcript: string): ExtractionOutput {
  const normalized = normalize(transcript);
  const matchedRules: string[] = [];

  let suggestedType: IncidentType | null = null;
  for (const rule of TYPE_RULES) {
    if (rule.patterns.some((p) => p.test(normalized))) {
      suggestedType = rule.type;
      matchedRules.push(`type:${rule.type}`);
      break;
    }
  }

  const signals: TranscriptionResult['signals'] = {};
  for (const [signal, patterns] of Object.entries(SIGNAL_RULES)) {
    if (patterns.some((p) => p.test(normalized))) {
      signals[signal as keyof typeof SIGNAL_RULES] = true;
      matchedRules.push(`signal:${signal}`);
    }
  }

  const suggestedPatientCount = extractPatientCount(normalized);
  if (suggestedPatientCount !== null) matchedRules.push(`patients:${suggestedPatientCount}`);

  return {
    suggestedType,
    suggestedPatientCount,
    signals,
    locationHint: extractLocationHint(transcript, normalized),
    matchedRules,
  };
}

/**
 * Confianza de la CLASIFICACION (distinta de la confianza acustica del
 * transcriptor). Si no reconocimos el tipo, no fingimos certeza: la UI pedira
 * confirmacion al ciudadano con botones grandes.
 */
export function classificationConfidence(output: ExtractionOutput, transcript: string): number {
  if (transcript.trim().length < 8) return 0;
  let score = output.suggestedType ? 0.6 : 0.2;
  if (Object.keys(output.signals).length > 0) score += 0.2;
  if (output.suggestedPatientCount !== null) score += 0.1;
  if (transcript.trim().length > 40) score += 0.1;
  return Math.min(1, score);
}
