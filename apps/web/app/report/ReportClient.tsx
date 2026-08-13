'use client';

import type { AudioReportResponse, IncidentType } from '@dispatch/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAudioRecorder } from './useAudioRecorder';

type Stage = 'locating' | 'ready' | 'sending' | 'error';

interface Position { lat: number; lng: number; accuracyM?: number }

/** Respaldo cuando no se puede grabar. Iconos grandes, no un <select>. */
const QUICK_TYPES: Array<{ type: IncidentType; label: string; icon: string }> = [
  { type: 'TRAFFIC_ACCIDENT', label: 'Accidente', icon: '🚗' },
  { type: 'CARDIAC', label: 'Dolor de pecho', icon: '❤️' },
  { type: 'UNCONSCIOUS', label: 'Inconsciente', icon: '😶' },
  { type: 'FALL', label: 'Caída', icon: '🤕' },
  { type: 'RESPIRATORY', label: 'No respira bien', icon: '🫁' },
  { type: 'OTHER', label: 'Otra', icon: '🆘' },
];

export function ReportClient() {
  const router = useRouter();
  const recorder = useAudioRecorder();
  const [stage, setStage] = useState<Stage>('locating');
  const [position, setPosition] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallbackType, setFallbackType] = useState<IncidentType | null>(null);

  // La ubicación se pide de entrada: es el dato sin el cual no podemos
  // despachar, y pedirlo al final obligaría a repetir el reporte.
  useEffect(() => {
    if (!navigator.geolocation) {
      setStage('ready');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
        });
        setStage('ready');
      },
      () => setStage('ready'),
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 },
    );
  }, []);

  const send = useCallback(async () => {
    if (!recorder.recording || !position) return;
    setStage('sending');
    setError(null);

    try {
      const response = await fetch('/api/incidents/audio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Un doble toque en un celular no puede crear dos reportes.
          'Idempotency-Key': `audio-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
        body: JSON.stringify({
          audioBase64: recorder.recording.base64,
          mimeType: recorder.recording.mimeType,
          durationSeconds: recorder.recording.durationSeconds,
          point: { lat: position.lat, lng: position.lng },
          accuracyM: position.accuracyM,
          fallbackType: fallbackType ?? undefined,
        }),
      });

      if (!response.ok) throw new Error(`El servidor respondió ${response.status}`);
      const result = (await response.json()) as AudioReportResponse;
      router.push(`/track/${result.trackingToken}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No pudimos enviar el reporte');
      setStage('ready');
    }
  }, [recorder.recording, position, fallbackType, router]);

  const canRecord = recorder.state !== 'unsupported' && recorder.state !== 'denied';
  const isRecording = recorder.state === 'recording';

  return (
    <main className="min-h-dvh bg-slate-950 text-slate-100 flex flex-col">
      <header className="px-6 pt-8 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Reportar emergencia</h1>
        <p className="mt-1 text-slate-400 text-sm">
          Cuéntanos qué está pasando. No necesitas registrarte.
        </p>
      </header>

      <div className="px-6">
        <LocationBadge stage={stage} position={position} />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-6">
        {canRecord && !recorder.recording && (
          <RecordButton
            isRecording={isRecording}
            level={recorder.level}
            seconds={recorder.seconds}
            onStart={recorder.start}
            onStop={recorder.stop}
          />
        )}

        {recorder.recording && (
          <ReviewPanel
            objectUrl={recorder.recording.objectUrl}
            seconds={recorder.recording.durationSeconds}
            sending={stage === 'sending'}
            onSend={send}
            onRetry={recorder.reset}
          />
        )}

        {!canRecord && (
          <FallbackPicker
            reason={recorder.state}
            selected={fallbackType}
            onSelect={setFallbackType}
          />
        )}

        {error && (
          <p role="alert" className="text-rose-300 text-sm text-center max-w-sm">{error}</p>
        )}
      </div>

      <footer className="px-6 pb-8 pt-4 text-center text-xs text-slate-500">
        Si la persona está en peligro inmediato, llama también al 123.
      </footer>
    </main>
  );
}

function LocationBadge({ stage, position }: { stage: Stage; position: Position | null }) {
  if (stage === 'locating') {
    return <Pill tone="neutral">Obteniendo tu ubicación…</Pill>;
  }
  if (!position) {
    return <Pill tone="warn">Sin ubicación — un operador te la pedirá</Pill>;
  }
  const accuracy = position.accuracyM ? ` · ±${Math.round(position.accuracyM)} m` : '';
  return <Pill tone="ok">Ubicación lista{accuracy}</Pill>;
}

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'neutral'; children: React.ReactNode }) {
  const styles = {
    ok: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
    warn: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
    neutral: 'bg-slate-500/10 text-slate-300 ring-slate-500/30',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs ring-1 ${styles}`}>
      {children}
    </span>
  );
}

/**
 * Botón de grabación. Ocupa el centro de la pantalla y es el único elemento
 * accionable: quien reporta puede estar con una mano, de noche, nervioso.
 */
function RecordButton({
  isRecording, level, seconds, onStart, onStop,
}: {
  isRecording: boolean; level: number; seconds: number;
  onStart: () => void; onStop: () => void;
}) {
  // El anillo crece con el volumen: prueba visible de que el micro capta.
  const ring = 1 + level * 0.35;

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative flex items-center justify-center" style={{ width: 240, height: 240 }}>
        {isRecording && (
          <span
            aria-hidden
            className="absolute rounded-full bg-rose-500/20 transition-transform duration-75"
            style={{ width: 200, height: 200, transform: `scale(${ring})` }}
          />
        )}
        <button
          type="button"
          onClick={isRecording ? onStop : onStart}
          aria-label={isRecording ? 'Detener grabación' : 'Grabar descripción de la emergencia'}
          className={[
            'relative rounded-full font-semibold text-lg shadow-2xl transition',
            'focus:outline-none focus-visible:ring-4 focus-visible:ring-rose-400/60',
            isRecording
              ? 'bg-rose-600 hover:bg-rose-500 text-white'
              : 'bg-rose-500 hover:bg-rose-400 text-white',
          ].join(' ')}
          style={{ width: 176, height: 176 }}
        >
          {isRecording ? (
            <span className="flex flex-col items-center gap-2">
              <span className="block h-8 w-8 rounded bg-white" />
              <span className="tabular-nums text-base">{seconds.toFixed(0)}s</span>
            </span>
          ) : (
            <span className="flex flex-col items-center gap-1">
              <span className="text-4xl">🎙️</span>
              <span>Hablar</span>
            </span>
          )}
        </button>
      </div>

      <p className="text-center text-slate-300 max-w-xs leading-relaxed">
        {isRecording
          ? 'Di qué pasó, cuántas personas están heridas y dónde estás.'
          : 'Toca y describe la emergencia con tus palabras.'}
      </p>
    </div>
  );
}

function ReviewPanel({
  objectUrl, seconds, sending, onSend, onRetry,
}: {
  objectUrl: string; seconds: number; sending: boolean;
  onSend: () => void; onRetry: () => void;
}) {
  return (
    <div className="w-full max-w-sm flex flex-col gap-4">
      <div className="rounded-2xl bg-slate-900 ring-1 ring-slate-800 p-4">
        <p className="text-sm text-slate-400 mb-3">
          Grabación de {seconds.toFixed(0)} segundos
        </p>
        {/* Escucharse antes de enviar evita reportes vacíos por un micro tapado. */}
        <audio controls src={objectUrl} className="w-full" />
      </div>

      <button
        type="button"
        onClick={onSend}
        disabled={sending}
        className="w-full rounded-2xl bg-rose-500 hover:bg-rose-400 disabled:opacity-60
                   text-white font-semibold py-5 text-lg shadow-lg transition
                   focus:outline-none focus-visible:ring-4 focus-visible:ring-rose-400/60"
      >
        {sending ? 'Enviando…' : 'Enviar reporte'}
      </button>

      <button
        type="button"
        onClick={onRetry}
        disabled={sending}
        className="w-full rounded-xl py-3 text-slate-300 hover:text-white transition disabled:opacity-50"
      >
        Grabar de nuevo
      </button>
    </div>
  );
}

/**
 * Camino de respaldo. El sistema nunca depende solo del audio: si el navegador
 * no graba o niegan el permiso, se puede reportar igual.
 */
function FallbackPicker({
  reason, selected, onSelect,
}: {
  reason: string; selected: IncidentType | null; onSelect: (type: IncidentType) => void;
}) {
  return (
    <div className="w-full max-w-sm flex flex-col gap-4">
      <p className="text-center text-amber-300 text-sm">
        {reason === 'denied'
          ? 'No tenemos permiso para usar el micrófono.'
          : 'Tu navegador no permite grabar audio.'}
        {' '}Elige qué está pasando:
      </p>
      <div className="grid grid-cols-2 gap-3">
        {QUICK_TYPES.map((option) => (
          <button
            key={option.type}
            type="button"
            onClick={() => onSelect(option.type)}
            className={[
              'rounded-2xl p-5 text-center transition ring-1',
              selected === option.type
                ? 'bg-rose-500/20 ring-rose-400 text-white'
                : 'bg-slate-900 ring-slate-800 text-slate-200 hover:ring-slate-600',
            ].join(' ')}
          >
            <span className="block text-3xl mb-2">{option.icon}</span>
            <span className="text-sm font-medium">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
