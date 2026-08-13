/**
 * Transcripcion de audio: voz -> texto.
 *
 * DEGRADA CON ELEGANCIA, A PROPOSITO. Si no hay API key configurada, o el
 * proveedor falla, o tarda demasiado, devuelve null y el reporte SE CREA IGUAL
 * con el audio guardado. Un ciudadano que reporta una emergencia no puede
 * perder su aviso porque un servicio externo tuvo un mal minuto.
 *
 * Orden: ElevenLabs Scribe -> OpenAI Whisper -> null.
 */

import { LOW_CONFIDENCE_THRESHOLD, type TranscriptionResult } from '@dispatch/contracts';
import { classificationConfidence, extractFromTranscript } from './extract.js';
import { logger } from '../../../infra/logger.js';

/** Presupuesto duro. Mas alla de esto preferimos despachar sin transcript que
 *  hacer esperar a quien esta frente a un herido. */
const TRANSCRIPTION_TIMEOUT_MS = 12_000;

interface Engine {
  name: string;
  isConfigured(): boolean;
  transcribe(audio: Buffer, mimeType: string): Promise<{ text: string; language: string | null }>;
}

const elevenLabs: Engine = {
  name: 'elevenlabs-scribe',
  isConfigured: () => Boolean(process.env.ELEVENLABS_API_KEY),
  async transcribe(audio, mimeType) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'report.webm');
    form.append('model_id', 'scribe_v1');

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as { text?: string; language_code?: string };
    return { text: data.text ?? '', language: data.language_code ?? null };
  },
};

const openAi: Engine = {
  name: 'openai-whisper',
  isConfigured: () => Boolean(process.env.OPENAI_API_KEY),
  async transcribe(audio, mimeType) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'report.webm');
    form.append('model', 'whisper-1');
    // Sesgar al español acelera y mejora bastante el reconocimiento en Cartagena.
    form.append('language', 'es');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as { text?: string; language?: string };
    return { text: data.text ?? '', language: data.language ?? 'es' };
  },
};

const ENGINES: readonly Engine[] = [elevenLabs, openAi];

export function transcriptionAvailable(): boolean {
  return ENGINES.some((e) => e.isConfigured());
}

/**
 * Transcribe y extrae campos. Nunca lanza: los fallos se registran y devuelve
 * null, porque quien llama debe poder crear el incidente igual.
 */
export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
): Promise<TranscriptionResult | null> {
  for (const engine of ENGINES) {
    if (!engine.isConfigured()) continue;

    try {
      const { text, language } = await engine.transcribe(audio, mimeType);
      if (!text.trim()) {
        logger.warn('transcripcion vacia', { engine: engine.name });
        continue;
      }

      // La transcripcion la hace un modelo; la ESTRUCTURACION es por reglas
      // (extract.ts). Asi la clasificacion es auditable y determinista.
      const extracted = extractFromTranscript(text);

      return {
        transcript: text.trim(),
        language,
        confidence: classificationConfidence(extracted, text),
        suggestedType: extracted.suggestedType,
        suggestedPatientCount: extracted.suggestedPatientCount,
        signals: extracted.signals,
        locationHint: extracted.locationHint,
        engine: engine.name,
      };
    } catch (error) {
      // Se intenta el siguiente motor. Un proveedor caido no debe tumbar la
      // entrada de reportes.
      logger.error('fallo el motor de transcripcion', {
        engine: engine.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

/** ¿Hay que pedir confirmacion al ciudadano antes de fiarnos de esto? */
export function needsHumanConfirmation(result: TranscriptionResult | null): boolean {
  if (!result) return true;
  if (!result.suggestedType) return true;
  return (result.confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD;
}
