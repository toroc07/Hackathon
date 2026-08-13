import { INCIDENT_TYPE, type IncidentType } from '@dispatch/contracts';
import { HttpError } from '../../errors.js';

/**
 * Nota de voz del reporter → texto. Usa la API de Groq (capa gratuita,
 * compatible con el formato de OpenAI) para no depender de infraestructura
 * propia de transcripción. Si `GROQ_API_KEY` no está configurada, falla
 * explícito: no hay fallback silencioso que finja transcribir.
 */
const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';

export async function transcribeAudio(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new HttpError(500, 'INTERNAL', 'Transcripción de audio no configurada (falta GROQ_API_KEY)');

  const form = new FormData();
  form.set('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename);
  form.set('model', GROQ_MODEL);
  form.set('language', 'es');
  form.set('response_format', 'json');

  const response = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    throw new HttpError(502, 'INTERNAL', `El servicio de transcripción falló (${response.status})`);
  }
  const payload = await response.json() as { text?: string };
  const text = (payload.text ?? '').trim();
  if (!text) throw new HttpError(422, 'VALIDATION_FAILED', 'No se entendió el audio. Intenta grabar de nuevo.');
  return text.slice(0, 1000);
}

/**
 * Clasificación de texto libre a `IncidentType` — por palabras clave, no LLM.
 * Es una SUGERENCIA editable en la UI; nunca fija la prioridad (§24, ver
 * README "La capa de IA y su límite": la IA captura y estructura, no decide).
 * Cada tipo tiene su fila de palabras clave, testeable como triage.ts.
 */
const TYPE_KEYWORDS: Record<Exclude<IncidentType, 'OTHER'>, readonly string[]> = {
  TRAFFIC_ACCIDENT: ['choque', 'accidente', 'atropell', 'volcó', 'volco', 'colisión', 'colision', 'moto', 'carro', 'atropello'],
  CARDIAC: ['dolor de pecho', 'infarto', 'corazón', 'corazon', 'paro cardiaco', 'paro cardíaco'],
  UNCONSCIOUS: ['inconsciente', 'no responde', 'desmayó', 'desmayo', 'no reacciona'],
  FALL: ['caída', 'caida', 'se cayó', 'se cayo', 'cayó de', 'cayo de'],
  // Incluye amputación/sangrado catastrófico — nunca debe perderse frente a
  // otro tipo detectado antes en la conversación (ver classifyAllIncidentTypes).
  TRAUMA: [
    'herida', 'herido', 'sangr', 'golpe', 'corte', 'apuñal', 'disparo', 'bala',
    'amputa', 'sin pierna', 'sin piernas', 'sin brazo', 'sin brazos',
    'perdió la pierna', 'perdió el brazo', 'le cortó', 'le cortaron',
  ],
  RESPIRATORY: ['no puede respirar', 'ahog', 'asfixi', 'falta de aire', 'respiración', 'respiracion'],
  OBSTETRIC: ['embarazada', 'parto', 'contraccion', 'contracción', 'dando a luz'],
};

/**
 * Todos los tipos cuyas palabras clave aparecen en el texto, en el orden del
 * vocabulario controlado. Una emergencia real puede ser varias cosas a la vez
 * (inconsciente Y con sangrado catastrófico) — quedarse con una sola lectura
 * puede hacer que se ignore la más grave. Úsalo cuando importe no perder
 * ninguna señal (p. ej. `converseTurn`); usa `classifyIncidentType` cuando
 * solo hace falta una sugerencia de un solo tipo.
 */
export function classifyAllIncidentTypes(text: string): IncidentType[] {
  const normalized = text.toLowerCase();
  const matches: IncidentType[] = [];
  for (const type of INCIDENT_TYPE) {
    if (type === 'OTHER') continue;
    const keywords = TYPE_KEYWORDS[type];
    if (keywords.some((keyword) => normalized.includes(keyword))) matches.push(type);
  }
  return matches;
}

export function classifyIncidentType(text: string): IncidentType | null {
  return classifyAllIncidentTypes(text)[0] ?? null;
}
