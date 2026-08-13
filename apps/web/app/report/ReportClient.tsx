'use client';

import type { ApiError, AudioReportResponse, IncidentType } from '@dispatch/contracts';
import { useCallback, useEffect, useRef, useState, type ComponentType, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  AlertIcon, CarCrashIcon, CheckIcon, FallIcon, HeartIcon, LocationIcon,
  LungsIcon, MicIcon, RetryIcon, SendIcon, SosIcon, StopIcon, UnconsciousIcon,
} from '@/src/components/ui/icons';
import { useAudioRecorder } from './useAudioRecorder';

type Stage = 'locating' | 'ready' | 'sending';
interface Position { lat: number; lng: number; accuracyM?: number }

const CARTAGENA = { minLat: 10.38, maxLat: 10.51, minLng: -75.59, maxLng: -75.46 };
const SEND_TIMEOUT_MS = 20_000;

const QUICK_TYPES: Array<{ type: IncidentType; label: string; Icon: ComponentType<{ size?: number }> }> = [
  { type: 'TRAFFIC_ACCIDENT', label: 'Accidente', Icon: CarCrashIcon },
  { type: 'CARDIAC', label: 'Emergencia médica', Icon: HeartIcon },
  { type: 'UNCONSCIOUS', label: 'Inconsciente', Icon: UnconsciousIcon },
  { type: 'FALL', label: 'Caída o lesión', Icon: FallIcon },
  { type: 'RESPIRATORY', label: 'No respira bien', Icon: LungsIcon },
  { type: 'OTHER', label: 'Otra emergencia', Icon: SosIcon },
];

function audioId(base64: string): string {
  let hash = 5381;
  for (let index = 0; index < base64.length; index += 1) {
    hash = ((hash << 5) + hash + base64.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function ReportClient({ citizenPhone }: { citizenPhone: string }) {
  const router = useRouter();
  const recorder = useAudioRecorder();
  const [stage, setStage] = useState<Stage>('locating');
  const [position, setPosition] = useState<Position | null>(null);
  const [locationPicker, setLocationPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackType, setFallbackType] = useState<IncidentType | null>(null);
  const mountedRef = useRef(true);

  const locate = useCallback(() => {
    setStage('locating');
    setError(null);
    if (!navigator.geolocation) {
      setStage('ready');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (result) => {
        if (!mountedRef.current) return;
        setPosition({ lat: result.coords.latitude, lng: result.coords.longitude, accuracyM: result.coords.accuracy });
        setLocationPicker(false);
        setStage('ready');
      },
      () => { if (mountedRef.current) setStage('ready'); },
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 },
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    locate();
    return () => { mountedRef.current = false; };
  }, [locate]);

  const pickApproximateLocation = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    setPosition({
      lng: CARTAGENA.minLng + x * (CARTAGENA.maxLng - CARTAGENA.minLng),
      lat: CARTAGENA.maxLat - y * (CARTAGENA.maxLat - CARTAGENA.minLat),
      accuracyM: 750,
    });
    setLocationPicker(false);
  };

  const send = useCallback(async () => {
    if (!recorder.recording) return;
    if (!position) {
      setError('Necesitamos una ubicación para enviar ayuda. Reintenta el GPS o marca una zona aproximada.');
      return;
    }
    if (recorder.recording.durationSeconds < 1) {
      setError('La grabación fue demasiado corta. Graba de nuevo y cuéntanos qué ocurrió.');
      return;
    }

    setStage('sending');
    setError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await fetch('/api/incidents/audio', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `audio-${audioId(recorder.recording.base64)}`,
        },
        body: JSON.stringify({
          audioBase64: recorder.recording.base64,
          mimeType: recorder.recording.mimeType,
          durationSeconds: recorder.recording.durationSeconds,
          point: { lat: position.lat, lng: position.lng },
          accuracyM: position.accuracyM,
          fallbackType: fallbackType ?? undefined,
          // Ya lo dejaste al registrarte — no se te vuelve a pedir. Es lo que
          // permite al responder llamarte si el audio no dio suficiente info.
          reporterContact: citizenPhone,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as ApiError | null;
        throw new Error(payload?.error.message ?? `No pudimos enviar el reporte (${response.status})`);
      }
      const result = (await response.json()) as AudioReportResponse;
      router.push(`/track/${result.trackingToken}`);
    } catch (cause) {
      const timedOut = cause instanceof DOMException && cause.name === 'AbortError';
      setError(timedOut
        ? 'La conexión tardó demasiado. Reintenta: conservamos tu grabación.'
        : cause instanceof Error ? cause.message : 'No pudimos enviar el reporte.');
      setStage('ready');
    } finally {
      window.clearTimeout(timer);
    }
  }, [fallbackType, position, recorder.recording, router]);

  const isRecording = recorder.state === 'recording';
  const canRecord = recorder.state !== 'unsupported' && recorder.state !== 'denied';
  const recording = recorder.recording;

  return (
    <main className="app-light mobile-app-shell safe-x flex flex-col">
      <header className="safe-top flex items-center gap-3 pb-4 animate-fade-up">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-emergency text-white shadow-lg" aria-hidden><SosIcon size={27} /></span>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[.18em] text-emergency">Emergencia</p>
          <h1 className="text-[22px] font-bold leading-tight tracking-tight min-[360px]:text-[24px]">Describe qué está pasando</h1>
        </div>
      </header>

      <LocationPanel
        stage={stage}
        position={position}
        openPicker={() => setLocationPicker(true)}
        retry={locate}
      />

      {locationPicker && (
        <ApproximateLocationPicker onPick={pickApproximateLocation} onClose={() => setLocationPicker(false)} />
      )}

      <div className="flex flex-1 flex-col items-center justify-center gap-6 py-6">
        {canRecord && !recording && (
          <RecordButton
            isRecording={isRecording}
            level={recorder.level}
            seconds={recorder.seconds}
            onStart={recorder.start}
            onStop={recorder.stop}
          />
        )}

        {recording && (
          <ReviewPanel
            seconds={recording.durationSeconds}
            selected={fallbackType}
            sending={stage === 'sending'}
            locationReady={Boolean(position)}
            onSelect={setFallbackType}
            onSend={send}
            onRetry={() => { recorder.reset(); setFallbackType(null); setError(null); }}
          />
        )}

        {!canRecord && <MicUnavailable reason={recorder.state} />}

        {error && (
          <p role="alert" className="flex max-w-sm items-start gap-2 rounded-xl bg-emergency-soft p-3 text-sm font-medium text-emergency">
            <AlertIcon size={19} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>

      <footer className="safe-bottom pt-3 text-center text-[13px] text-content-muted">
        En peligro inmediato, llama también al <a className="font-semibold text-emergency underline" href="tel:123">123</a>.
      </footer>
    </main>
  );
}

function LocationPanel({ stage, position, retry, openPicker }: {
  stage: Stage; position: Position | null; retry: () => void; openPicker: () => void;
}) {
  if (stage === 'locating') {
    return <div role="status" className="flex items-center gap-2 rounded-xl bg-surface-raised px-4 py-3 text-sm text-content-secondary"><LocationIcon size={18} /> Obteniendo tu ubicación…</div>;
  }
  if (position) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-edge-subtle bg-ok-soft px-4 py-3 text-sm text-ok">
        <CheckIcon size={19} />
        <span className="flex-1 font-medium">Ubicación lista{position.accuracyM ? ` · ±${Math.round(position.accuracyM)} m` : ''}</span>
        <button className="min-h-touch rounded-lg px-2 font-semibold underline" type="button" onClick={openPicker}>Cambiar</button>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-warn/30 bg-warn-soft p-4 text-sm text-warn">
      <p className="flex items-start gap-2 font-medium"><AlertIcon size={19} /> No pudimos detectar tu ubicación.</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={retry} className="min-h-touch rounded-xl bg-surface-base px-3 font-semibold ring-1 ring-warn/30">Reintentar GPS</button>
        <button type="button" onClick={openPicker} className="min-h-touch rounded-xl bg-surface-base px-3 font-semibold ring-1 ring-warn/30">Marcar zona</button>
      </div>
    </div>
  );
}

function ApproximateLocationPicker({ onPick, onClose }: {
  onPick: (event: MouseEvent<HTMLButtonElement>) => void; onClose: () => void;
}) {
  return (
    <section className="mt-3 rounded-2xl border border-edge-subtle bg-surface-raised p-3" aria-labelledby="approx-location-title">
      <div className="flex items-center justify-between gap-3">
        <div><h2 id="approx-location-title" className="font-semibold">Marca una zona aproximada</h2><p className="text-xs text-content-muted">Toca el mapa de Cartagena donde estás.</p></div>
        <button type="button" onClick={onClose} className="min-h-touch px-2 text-sm font-semibold text-content-secondary">Cerrar</button>
      </div>
      <button type="button" onClick={onPick} className="map-paper relative mt-3 h-44 w-full overflow-hidden rounded-xl text-left ring-1 ring-edge-subtle" aria-label="Mapa aproximado de Cartagena; toca para marcar tu ubicación">
        <span className="absolute left-[14%] top-[12%] text-xs font-semibold text-content-muted">Crespo</span>
        <span className="absolute left-[43%] top-[38%] text-xs font-semibold text-content-muted">Centro</span>
        <span className="absolute bottom-[18%] left-[18%] text-xs font-semibold text-content-muted">Bocagrande</span>
        <span className="absolute bottom-3 right-3 rounded-full bg-surface-base/90 px-3 py-1 text-xs font-semibold text-info shadow">Toca para ubicarte</span>
      </button>
    </section>
  );
}

function RecordButton({ isRecording, level, seconds, onStart, onStop }: {
  isRecording: boolean; level: number; seconds: number; onStart: () => void; onStop: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="relative grid h-[244px] w-[244px] place-items-center">
        {isRecording && <span aria-hidden className="absolute h-48 w-48 rounded-full bg-emergency-soft" style={{ transform: `scale(${1 + level * .32})`, transition: 'transform 90ms linear' }} />}
        <button
          type="button"
          onClick={isRecording ? onStop : onStart}
          aria-label={isRecording ? 'Detener grabación' : 'Grabar descripción de la emergencia'}
          className={`pressable relative flex h-44 w-44 flex-col items-center justify-center gap-2 rounded-full bg-emergency text-white shadow-2xl ${isRecording ? '' : 'animate-breathe'}`}
        >
          {isRecording ? <StopIcon size={42} /> : <MicIcon size={46} />}
          <span className="text-lg font-bold">{isRecording ? <span className="tnum">{seconds.toFixed(0)} s</span> : 'Toca para hablar'}</span>
        </button>
      </div>
      <p aria-live="polite" className="max-w-[19rem] text-[15px] leading-relaxed text-content-secondary">
        {isRecording ? 'Di qué pasó, cuántas personas necesitan ayuda y una referencia del lugar.' : 'Puedes hablar con tus palabras. Te haremos una pregunta antes de enviar.'}
      </p>
    </div>
  );
}

function ReviewPanel({ seconds, selected, sending, locationReady, onSelect, onSend, onRetry }: {
  seconds: number; selected: IncidentType | null; sending: boolean; locationReady: boolean;
  onSelect: (type: IncidentType) => void; onSend: () => void; onRetry: () => void;
}) {
  return (
    <section className="w-full animate-fade-up" aria-labelledby="confirm-type-title">
      <div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-emergency">Pregunta 1 de 1</p><h2 id="confirm-type-title" className="mt-1 text-xl font-bold">¿Qué tipo de emergencia es?</h2></div><span className="rounded-full bg-ok-soft px-3 py-1 text-xs font-semibold text-ok"><span className="tnum">{Math.round(seconds)}</span> s grabados</span></div>
      <div className="grid grid-cols-2 gap-3">
        {QUICK_TYPES.map(({ type, label, Icon }) => {
          const active = selected === type;
          return <button key={type} type="button" aria-pressed={active} onClick={() => onSelect(type)} className={`pressable min-h-[78px] rounded-xl border p-3 text-left ${active ? 'border-emergency bg-emergency-soft text-emergency' : 'border-edge-subtle bg-surface-base text-content-secondary'}`}><Icon size={25} /><span className="mt-2 block text-sm font-semibold">{label}</span></button>;
        })}
      </div>
      <button type="button" disabled={sending || !locationReady} aria-busy={sending} onClick={onSend} className="pressable mt-5 flex min-h-touch-lg w-full items-center justify-center gap-2 rounded-xl bg-emergency px-4 text-lg font-bold text-white shadow-lg disabled:opacity-50"><SendIcon size={21} />{sending ? 'Enviando reporte…' : 'Enviar reporte'}</button>
      <button type="button" disabled={sending} onClick={onRetry} className="pressable mt-2 flex min-h-touch w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-content-secondary"><RetryIcon size={18} /> Grabar de nuevo</button>
    </section>
  );
}

function MicUnavailable({ reason }: { reason: string }) {
  return (
    <section className="state-card w-full p-5 text-center">
      <AlertIcon className="mx-auto text-warn" size={34} />
      <h2 className="mt-3 text-xl font-bold">No podemos usar el micrófono</h2>
      <p className="mt-2 text-sm text-content-secondary">{reason === 'denied' ? 'Activa el permiso del micrófono en tu navegador.' : 'Este navegador no permite grabar audio.'}</p>
      <a href="tel:123" className="mt-5 flex min-h-touch-lg items-center justify-center rounded-xl bg-emergency px-4 font-bold text-white">Llamar al 123</a>
    </section>
  );
}
