import { INCIDENT_TYPE, type IncidentType, type TranscribeAudioResponse } from '@dispatch/contracts';
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
  TRAUMA: ['herida', 'herido', 'sangr', 'golpe', 'corte', 'apuñal', 'disparo', 'bala'],
  RESPIRATORY: ['no puede respirar', 'ahog', 'asfixi', 'falta de aire', 'respiración', 'respiracion'],
  OBSTETRIC: ['embarazada', 'parto', 'contraccion', 'contracción', 'dando a luz'],
};

export function classifyIncidentType(text: string): IncidentType | null {
  const normalized = text.toLowerCase();
  for (const type of INCIDENT_TYPE) {
    if (type === 'OTHER') continue;
    const keywords = TYPE_KEYWORDS[type];
    if (keywords.some((keyword) => normalized.includes(keyword))) return type;
  }
  return null;
}

export interface VoiceReport {
  summary: string;
  suggestedType: IncidentType | null;
  suggestedPatientCount: number | null;
}

/**
 * Transcripción → reporte estructurado, vía LLM (mismo Groq, mismo
 * GROQ_API_KEY que la transcripción — un solo proveedor gratuito).
 * A diferencia de `transcribeAudio`, esto NUNCA lanza: si el modelo falla,
 * no responde JSON válido, o no hay red, se cae al clasificador por
 * palabras clave y al texto crudo como resumen. Analizar es una ayuda,
 * no un requisito — no vamos a bloquear el reporte de una emergencia
 * porque el LLM tuvo un mal día.
 *
 * Límites explícitos del prompt (README "La capa de IA y su límite", §24):
 * el modelo NUNCA fija prioridad ni marca señales críticas
 * (unconscious/notBreathing/severeBleeding/trapped) — esas siguen siendo
 * botones explícitos que solo el humano marca.
 */
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';

const REPORT_SYSTEM_PROMPT = `Eres un asistente que ESTRUCTURA reportes de emergencia para un centro de despacho de ambulancias en Cartagena, Colombia. Tu única función es capturar y organizar lo que dice un ciudadano en su nota de voz.

Reglas estrictas:
- NUNCA determinas prioridad médica.
- NUNCA afirmas que la persona está inconsciente, no respira, sangra severamente o está atrapada, aunque el texto lo sugiera — eso lo confirma un humano con un botón.
- Si el texto no da información clara para un campo, usa null. No inventes.

Responde SOLO con un JSON, sin texto adicional, con esta forma exacta:
{"summary": string, "type": string o null, "patientCount": number o null}

- "summary": 1-2 frases en español, tercera persona, resumiendo qué está pasando y dónde si se menciona. Sin opiniones ni prioridad.
- "type": uno de ${JSON.stringify(INCIDENT_TYPE)}, o null si no es claro.
- "patientCount": número de personas afectadas SOLO si se menciona explícitamente, si no null.`;

export async function analyzeTranscript(transcript: string): Promise<VoiceReport> {
  const fallback: VoiceReport = { summary: transcript, suggestedType: classifyIncidentType(transcript), suggestedPatientCount: null };
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return fallback;

  try {
    const response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_CHAT_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: REPORT_SYSTEM_PROMPT },
          { role: 'user', content: transcript },
        ],
      }),
    });
    if (!response.ok) return fallback;

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = payload.choices?.[0]?.message?.content;
    if (!raw) return fallback;

    const parsed = JSON.parse(raw) as { summary?: unknown; type?: unknown; patientCount?: unknown };
    const summary = typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim().slice(0, 1000) : transcript;
    const suggestedType = typeof parsed.type === 'string' && (INCIDENT_TYPE as readonly string[]).includes(parsed.type)
      ? parsed.type as IncidentType
      : classifyIncidentType(transcript);
    const suggestedPatientCount = typeof parsed.patientCount === 'number'
      && Number.isInteger(parsed.patientCount) && parsed.patientCount >= 0 && parsed.patientCount <= 50
      ? parsed.patientCount
      : null;
    return { summary, suggestedType, suggestedPatientCount };
  } catch {
    return fallback;
  }
}

/**
 * Nota de voz del reporter → transcripción + reporte sugerido. No persiste
 * nada: el cliente (la PWA del reporter) sigue enviando `POST /incidents` al
 * backend principal con lo que confirme en pantalla.
 */
export async function transcribeVoiceReport(buffer: Buffer, mimeType: string, filename: string): Promise<TranscribeAudioResponse> {
  const transcript = await transcribeAudio(buffer, mimeType, filename);
  const report = await analyzeTranscript(transcript);
  return { transcript, report };
}
