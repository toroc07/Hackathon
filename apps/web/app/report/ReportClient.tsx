'use client';

import type { AudioReportResponse, IncidentType } from '@dispatch/contracts';
import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertIcon, CarCrashIcon, CheckIcon, FallIcon, HeartIcon, LocationIcon,
  LungsIcon, MicIcon, RetryIcon, SendIcon, SosIcon, StopIcon, UnconsciousIcon,
} from '@/src/components/ui/icons';
import { useAudioRecorder } from './useAudioRecorder';

type Stage = 'locating' | 'ready' | 'sending';

interface Position { lat: number; lng: number; accuracyM?: number }

/** Respaldo cuando no se puede grabar. Iconos vectoriales + etiqueta: el icono
 *  solo nunca comunica, y aquí no hay margen para adivinar. */
const QUICK_TYPES: Array<{ type: IncidentType; label: string; Icon: ComponentType<{ size?: number }> }> = [
  { type: 'TRAFFIC_ACCIDENT', label: 'Accidente', Icon: CarCrashIcon },
  { type: 'CARDIAC', label: 'Dolor de pecho', Icon: HeartIcon },
  { type: 'UNCONSCIOUS', label: 'Inconsciente', Icon: UnconsciousIcon },
  { type: 'FALL', label: 'Caída', Icon: FallIcon },
  { type: 'RESPIRATORY', label: 'No respira bien', Icon: LungsIcon },
  { type: 'OTHER', label: 'Otra', Icon: SosIcon },
];

export function ReportClient() {
  const router = useRouter();
  const recorder = useAudioRecorder();
  const [stage, setStage] = useState<Stage>('locating');
  const [position, setPosition] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallbackType, setFallbackType] = useState<IncidentType | null>(null);

  // La ubicación se pide de entrada: es el dato sin el cual no podemos
  // despachar, y pedirlo al final obligaría a repetir el reporte entero.
  useEffect(() => {
    if (!navigator.geolocation) { setStage('ready'); return; }
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
    <main className="min-h-dvh flex flex-col safe-x">
      <header className="safe-top pb-4">
        <h1 className="text-[26px] font-semibold tracking-tight leading-tight">
          Reportar emergencia
        </h1>
        <p className="mt-1 text-content-secondary text-[15px]">
          Cuéntanos qué está pasando. No necesitas registrarte.
        </p>
      </header>

      <LocationBadge stage={stage} position={position} />

      <div className="flex-1 flex flex-col items-center justify-center gap-6 py-6">
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

        {/* role=alert para que el lector de pantalla lo anuncie sin esperar. */}
        {error && (
          <p role="alert" className="flex items-start gap-2 text-emergency text-sm max-w-sm">
            <AlertIcon size={18} />
            <span>{error}</span>
          </p>
        )}
      </div>

      <footer className="safe-bottom pt-4 text-center text-[13px] text-content-muted">
        Si la persona está en peligro inmediato, llama también al 123.
      </footer>
    </main>
  );
}

function LocationBadge({ stage, position }: { stage: Stage; position: Position | null }) {
  if (stage === 'locating') {
    return <Pill tone="neutral" Icon={LocationIcon}>Obteniendo tu ubicación…</Pill>;
  }
  if (!position) {
    return <Pill tone="warn" Icon={AlertIcon}>Sin ubicación — un operador te la pedirá</Pill>;
  }
  const accuracy = position.accuracyM ? ` · ±${Math.round(position.accuracyM)} m` : '';
  return <Pill tone="ok" Icon={CheckIcon}>Ubicación lista{accuracy}</Pill>;
}

function Pill({
  tone, Icon, children,
}: {
  tone: 'ok' | 'warn' | 'neutral';
  Icon: ComponentType<{ size?: number }>;
  children: React.ReactNode;
}) {
  // Color + icono, nunca color solo: al sol y en escala de grises el tono se
  // pierde, el icono no.
  const styles = {
    ok:      'bg-ok-soft text-ok',
    warn:    'bg-warn-soft text-warn',
    neutral: 'bg-surface-raised text-content-secondary',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-2 self-start rounded-full px-3 py-2 text-[13px] ${styles}`}>
      <Icon size={16} />
      {children}
    </span>
  );
}

/**
 * Botón de grabación: el único elemento accionable de la pantalla.
 * 176px de diámetro, muy por encima del mínimo de 48px, porque quien lo usa
 * puede estar temblando o con una sola mano.
 */
function RecordButton({
  isRecording, level, seconds, onStart, onStop,
}: {
  isRecording: boolean; level: number; seconds: number;
  onStart: () => void; onStop: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="relative flex items-center justify-center" style={{ width: 248, height: 248 }}>
        {isRecording && (
          <>
            {/* Anillo que responde al volumen: prueba visible de que el micro
                capta. Sin esto la gente repite el reporte por no saberlo. */}
            <span
              aria-hidden
              className="absolute rounded-full bg-emergency-soft"
              style={{
                width: 212, height: 212,
                transform: `scale(${1 + level * 0.32})`,
                transition: 'transform 90ms linear',
              }}
            />
            <span aria-hidden
                  className="absolute rounded-full bg-emergency-soft animate-pulse-ring"
                  style={{ width: 212, height: 212 }} />
          </>
        )}
        <button
          type="button"
          onClick={isRecording ? onStop : onStart}
          aria-label={isRecording ? 'Detener grabación' : 'Grabar descripción de la emergencia'}
          className="pressable relative rounded-full font-semibold shadow-2xl
                     bg-emergency hover:bg-emergency-hover active:bg-emergency-pressed
                     text-white flex flex-col items-center justify-center gap-2"
          style={{ width: 176, height: 176 }}
        >
          {isRecording ? <StopIcon size={40} /> : <MicIcon size={44} />}
          <span className="text-[17px]">
            {isRecording ? <span className="tnum">{seconds.toFixed(0)}s</span> : 'Hablar'}
          </span>
        </button>
      </div>

      {/* aria-live: el cambio de instrucción se anuncia al iniciar la grabación. */}
      <p aria-live="polite"
         className="text-center text-content-secondary max-w-[19rem] text-[15px] leading-relaxed">
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
      <div className="rounded-md bg-surface-raised ring-1 ring-edge-subtle p-4">
        <p className="text-[13px] text-content-muted mb-3">
          Grabación de <span className="tnum">{seconds.toFixed(0)}</span> segundos
        </p>
        {/* Escucharse antes de enviar evita reportes vacíos por un micro tapado. */}
        <audio controls src={objectUrl} className="w-full" />
      </div>

      <button
        type="button"
        onClick={onSend}
        disabled={sending}
        aria-busy={sending}
        className="pressable w-full rounded-md bg-emergency hover:bg-emergency-hover
                   active:bg-emergency-pressed disabled:opacity-60 text-white font-semibold
                   text-[17px] shadow-lg flex items-center justify-center gap-2"
        style={{ minHeight: 'var(--touch-comfort)' }}
      >
        <SendIcon size={20} />
        {sending ? 'Enviando…' : 'Enviar reporte'}
      </button>

      <button
        type="button"
        onClick={onRetry}
        disabled={sending}
        className="pressable w-full rounded-sm text-content-secondary hover:text-content
                   disabled:opacity-50 flex items-center justify-center gap-2 text-[15px]"
        style={{ minHeight: 'var(--touch-min)' }}
      >
        <RetryIcon size={18} />
        Grabar de nuevo
      </button>
    </div>
  );
}

/**
 * Camino de respaldo. El sistema nunca depende solo del audio: sin permiso de
 * micrófono o en un navegador que no graba, se puede reportar igual.
 */
function FallbackPicker({
  reason, selected, onSelect,
}: {
  reason: string; selected: IncidentType | null; onSelect: (type: IncidentType) => void;
}) {
  return (
    <div className="w-full max-w-sm flex flex-col gap-4">
      <p className="flex items-start gap-2 text-warn text-[15px]">
        <AlertIcon size={18} />
        <span>
          {reason === 'denied'
            ? 'No tenemos permiso para usar el micrófono.'
            : 'Tu navegador no permite grabar audio.'}
          {' '}Elige qué está pasando:
        </span>
      </p>
      <div className="grid grid-cols-2 gap-3">
        {QUICK_TYPES.map(({ type, label, Icon }) => {
          const active = selected === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => onSelect(type)}
              aria-pressed={active}
              className={[
                'pressable rounded-md p-4 flex flex-col items-center gap-2 ring-1 text-center',
                active
                  ? 'bg-emergency-soft ring-emergency text-content'
                  : 'bg-surface-raised ring-edge-subtle text-content-secondary',
              ].join(' ')}
              style={{ minHeight: 'var(--touch-comfort)' }}
            >
              <Icon size={28} />
              <span className="text-[13px] font-medium leading-tight">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
