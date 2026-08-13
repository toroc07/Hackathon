import type { ConversationTurn, IncidentType } from '@dispatch/contracts';
import { HttpError } from '../../errors.js';
import { formatFirstAidProtocols } from './firstAid.js';
import { classifyAllIncidentTypes } from './voice.js';

/**
 * "Llamada" con la IA: un turno de conversación por voz mientras el
 * reportero espera la ambulancia. Mismo Groq/GROQ_API_KEY que transcripción
 * y análisis — un solo proveedor.
 *
 * Límites del prompt (README "La capa de IA y su límite", §24): orienta con
 * calma, NUNCA da diagnóstico médico, NUNCA fija ni menciona prioridad,
 * NUNCA promete tiempos de llegada (no los conoce). A diferencia de
 * `analyzeTranscript`, un fallo acá SÍ se propaga: si la IA no puede
 * responder, no hay conversación — no fingimos una respuesta genérica.
 */
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
// "instant" en vez de "versatile": es una llamada en vivo, la latencia importa
// más que el razonamiento profundo — y ya le damos el protocolo médico hecho
// en el prompt (firstAid.ts), así que no depende de la "inteligencia" del
// modelo para responder bien, solo de que lo comunique con calma.
const GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.1-8b-instant';
// Fuerza respuestas cortas: además de más rápidas de generar, es justo lo que
// pide el prompt (1-3 frases, se leen en voz alta). ~200 tokens ≈ 3-4 frases.
const GROQ_CHAT_MAX_TOKENS = 200;

const CALL_SYSTEM_PROMPT = `Eres un asistente de voz que acompaña a un ciudadano que está reportando una emergencia en Cartagena, Colombia, mientras espera la ambulancia. Hablas como un operador de emergencias calmado y claro, en español, en oraciones cortas — esto se lee en voz alta, no se lee como texto.

Tu función:
- Dar instrucciones básicas y seguras de qué hacer MIENTRAS llega la ayuda, basadas en el contexto médico de referencia que se te da a continuación si lo hay — no improvises un procedimiento distinto al de esa referencia.
- Si el reportero menciona una lesión grave nueva (sangrado severo, amputación, no respira), esa pasa a ser tu prioridad inmediata en la siguiente respuesta — nunca la minimices ni la dejes "para después" con frases como "eso no es importante ahora" o "no se preocupe por eso". Reconoce la gravedad y da la instrucción correspondiente primero.
- Hacer como máximo UNA pregunta de seguimiento breve si falta información crítica (¿está consciente?, ¿respira?, ¿hay más heridos?).
- Mantener la calma del reportero con un tono breve y humano — calma no es lo mismo que minimizar.

Lo que NUNCA haces:
- Nunca das un diagnóstico médico ni nombras una enfermedad.
- Nunca decides ni mencionas la prioridad de la emergencia — eso lo decide el sistema con reglas explícitas, no tú.
- Nunca prometes ni sugieres que la ayuda "ya viene", "está en camino", "llegará pronto/enseguida" ni das tiempos de llegada de ningún tipo — no los conoces. Si el reportero pregunta cuánto falta, dile que no lo sabes y que se concentre en lo que puede hacer ahora.
- Si hay riesgo vital inmediato, recuerda con calma llamar también al 123 si aún no lo han hecho.

Responde en 1-3 frases cortas, en español, sin markdown ni listas.`;

export interface ConverseResult {
  reply: string;
  detectedTypes: IncidentType[];
}

export async function converseTurn(userMessage: string, history: readonly ConversationTurn[]): Promise<ConverseResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new HttpError(500, 'INTERNAL', 'Conversación no configurada (falta GROQ_API_KEY)');

  // Todo lo dicho por el reportero hasta ahora, no solo el turno actual — una
  // emergencia puede revelar información más grave a mitad de conversación
  // (ver §33: nunca perder una señal de trauma nueva por quedarse pegado al
  // primer tipo detectado). classifyAllIncidentTypes, no la versión de un
  // solo resultado: si aplica más de un tipo, el LLM recibe TODOS los protocolos.
  const allUserText = [...history.filter((turn) => turn.role === 'user').map((turn) => turn.content), userMessage].join(' ');
  const detectedTypes = classifyAllIncidentTypes(allUserText);
  const systemPrompt = detectedTypes.length > 0
    ? `${CALL_SYSTEM_PROMPT}\n\n${formatFirstAidProtocols(detectedTypes)}`
    : CALL_SYSTEM_PROMPT;

  const messages = [
    { role: 'system', content: systemPrompt },
    // Suficiente memoria para una llamada de emergencia corta, sin dejar crecer el prompt sin límite.
    ...history.slice(-12).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: userMessage },
  ];

  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GROQ_CHAT_MODEL, temperature: 0.4, max_tokens: GROQ_CHAT_MAX_TOKENS, messages }),
  });
  if (!response.ok) throw new HttpError(502, 'INTERNAL', `El asistente de voz falló (${response.status})`);

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const reply = payload.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new HttpError(502, 'INTERNAL', 'El asistente de voz no respondió');
  return { reply: reply.slice(0, 2000), detectedTypes };
}

/**
 * Texto → voz, para que la respuesta se sienta como una llamada. A
 * diferencia de `converseTurn`, esto es puramente cosmético: si TODOS los
 * proveedores fallan, la conversación sigue igual (el cliente cae a la voz
 * nativa del navegador). Nunca lanza.
 *
 * Orden de proveedores: ElevenLabs primero si hay `ELEVENLABS_API_KEY` (mejor
 * calidad de voz en español, capa gratuita ~10 min/mes), si no Groq (mismo
 * GROQ_API_KEY que ya usamos, pero su modelo actual pide aceptar términos a
 * mano — ver .env.example).
 */
export interface SynthesizedSpeech {
  buffer: Buffer;
  mimeType: string;
}

const ELEVENLABS_TTS_URL = (voiceId: string) => `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
// flash (no turbo): es el modelo de menor latencia de ElevenLabs, pensado para
// agentes conversacionales en vivo — justo este caso. Algo menos de calidad
// de voz a cambio de bastante menos espera.
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
// El plan gratuito de ElevenLabs solo permite por API las voces "premade" de
// la propia cuenta (GET /v1/voices), no la librería completa — "Rachel"
// (21m00Tcm4TlvDq8ikWAM) da 402 en cuentas free. "Sarah" es premade y funciona.
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

async function synthesizeWithElevenLabs(text: string): Promise<SynthesizedSpeech | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch(ELEVENLABS_TTS_URL(ELEVENLABS_VOICE_ID), {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
    });
    if (!response.ok) return null;
    return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/mpeg' };
  } catch {
    return null;
  }
}

const GROQ_TTS_URL = 'https://api.groq.com/openai/v1/audio/speech';
// playai-tts fue descontinuado por Groq. orpheus-v1-english es el reemplazo,
// pero requiere que el admin de la cuenta acepte los términos del modelo en
// https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english
const GROQ_TTS_MODEL = process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english';
const GROQ_TTS_VOICE = process.env.GROQ_TTS_VOICE || 'tara';

async function synthesizeWithGroq(text: string): Promise<SynthesizedSpeech | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch(GROQ_TTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_TTS_MODEL, voice: GROQ_TTS_VOICE, input: text, response_format: 'wav' }),
    });
    if (!response.ok) return null;
    return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/wav' };
  } catch {
    return null;
  }
}

export async function synthesizeSpeech(text: string): Promise<SynthesizedSpeech | null> {
  return (await synthesizeWithElevenLabs(text)) ?? (await synthesizeWithGroq(text));
}
