'use client';

import { MAX_AUDIO_SECONDS, type AudioReportResponse } from '@dispatch/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertIcon, CheckIcon, LocationIcon, MicIcon, RetryIcon, StopIcon } from '@/src/components/ui/icons';
import { useAudioRecorder } from '@/src/hooks/useAudioRecorder';

/**
 * Reporte ciudadano de emergencias. Una sola pantalla, un solo botón:
 * grabar, enviar, confirmar. Sin registro, sin pasos intermedios.
 *
 * Flujo: grabar voz -> enviar a /api/incidents/audio -> confirmar con el
 * incidentId real que devuelve el despacho. Si algo falla, reintentar
 * reenvía la misma grabación (nunca hay que repetir el relato en la calle).
 */
type Phase = 'idle' | 'starting' | 'recording' | 'sending' | 'confirmed' | 'error' | 'unavailable';

interface Position { lat: number; lng: number; accuracyM?: number }

const MIN_SECONDS = 2;
const SEND_TIMEOUT_MS = 20_000;
const LOC_KEY = 'dp_audio_location';

/** Hash corto y estable del audio: la misma grabación siempre genera la misma
 *  Idempotency-Key, así el reintento nunca crea un reporte duplicado en el
 *  servidor (no vale depender solo del dedupe en el cliente). */
function audioId(base64: string): string {
  let h = 5381;
  for (let i = 0; i < base64.length; i += 1) {
    h = ((h << 5) + h + base64.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export default function ReportPage() {
  const recorder = useAudioRecorder();
  const [phase, setPhase] = useState<Phase>('idle');
  const [position, setPosition] = useState<Position | null>(null);
  const [locating, setLocating] = useState(true);
  const [label, setLabel] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try { return localStorage.getItem(LOC_KEY) ?? ''; } catch { return ''; }
  });
  const [incident, setIncident] = useState<AudioReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const sentKeyRef = useRef<string | null>(null);
  // La ubicación se pide de entrada: sin ella no se puede despachar.
  useEffect(() => {
    if (!navigator.geolocation) { setLocating(false); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy });
        setLocating(false);
      },
      () => { setLocating(false); },
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 },
    );
  }, []);

  const send = useCallback(async () => {
    if (!recorder.recording) return;
    if (!position) {
      setError('No pudimos obtener tu ubicación. Reintenta o llama al 123.');
      setPhase('error');
      return;
    }
    if (recorder.recording.durationSeconds < MIN_SECONDS) {
      setError('La grabación es muy corta. Intenta de nuevo.');
      recorder.reset();
      setPhase('idle');
      return;
    }

    setPhase('sending');
    setError(null);

    // Timeout propio: sin esto, una red muerta deja al usuario colgado en
    // "Enviando…" sin posibilidad de reintentar.
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await fetch('/api/incidents/audio', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          // Clave derivada del audio: reintentar la misma grabación se
          // deduplica en el servidor y un doble toque no crea dos reportes.
          'Idempotency-Key': `audio-${audioId(recorder.recording.base64)}`,
        },
        body: JSON.stringify({
          audioBase64: recorder.recording.base64,
          mimeType: recorder.recording.mimeType,
          durationSeconds: recorder.recording.durationSeconds,
          point: { lat: position.lat, lng: position.lng },
          accuracyM: position.accuracyM,
        }),
      });
      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? 'No pudimos autenticar el reporte.'
          : response.status === 404
            ? 'El servicio de despacho no está disponible.'
            : response.status === 409
              ? 'Este reporte ya fue registrado.'
              : response.status === 422
                ? 'El reporte no pasó la validación.'
                : `El servidor respondió ${response.status}`;
        throw new Error(message);
      }
      const result = (await response.json()) as AudioReportResponse;
      setIncident(result);
      setPhase('confirmed');
    } catch (cause) {
      const timedOut = cause instanceof DOMException && cause.name === 'AbortError';
      setError(timedOut
        ? 'Se agotó el tiempo de espera. Revisa tu conexión y reintenta.'
        : cause instanceof Error ? cause.message : 'No pudimos enviar el reporte');
      setPhase('error');
    } finally {
      window.clearTimeout(timer);
    }
  }, [recorder, position]);

  useEffect(() => {
    if (recorder.state === 'requesting') setPhase('starting');
    if (recorder.state === 'recording') setPhase('recording');
  }, [recorder.state]);

  // Al soltar el botón la grabación está lista: se envía sola.
  useEffect(() => {
    if (recorder.state === 'stopped' && recorder.recording) {
      const key = recorder.recording.base64;
      if (sentKeyRef.current === key) return;
      sentKeyRef.current = key;
      void send();
    }
  }, [recorder.state, recorder.recording, send]);

  useEffect(() => {
    if (recorder.state === 'unsupported' || recorder.state === 'denied') setPhase('unavailable');
  }, [recorder.state]);

  const newReport = () => {
    recorder.reset();
    sentKeyRef.current = null;
    setIncident(null);
    setError(null);
    setPhase('idle');
  };

  const openModal = () => {
    setLabelDraft(label);
    setModalOpen(true);
  };
  const saveLabel = () => {
    const value = labelDraft.trim();
    setLabel(value);
    if (value) { try { localStorage.setItem(LOC_KEY, value); } catch { /* sin almacenamiento */ } }
    setModalOpen(false);
  };

  return (
    <main className="min-h-dvh flex flex-col safe-x">
      <header className="safe-top flex items-center gap-3 pb-4 animate-fade-up">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/isotipo_sin_fondo.png"
          alt="Despacho Cartagena"
          className="h-12 w-12 object-contain shrink-0"
        />
        <div>
          <h1 className="text-[28px] font-extrabold tracking-[1.5px] leading-tight text-emergency">
            EMERGENCIA
          </h1>
          <p className="mt-0.5 text-content-secondary text-[15px]">
            Cuéntanos qué está pasando. No necesitas registrarte.
          </p>
        </div>
      </header>

      <div className="animate-fade-up" style={{ animationDelay: '80ms' }}>
        <LocationBar
          locating={locating}
          position={position}
          label={label}
          onChange={openModal}
        />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-6 py-6 animate-fade-up" style={{ animationDelay: '160ms' }}>
        {phase === 'confirmed' && incident ? (
          <ConfirmationCard incident={incident} onNew={newReport} />
        ) : (
          <>
            {phase !== 'unavailable' && (
              <RecordButton
                phase={phase}
                level={recorder.level}
                seconds={recorder.seconds}
                onStart={recorder.start}
                onStop={recorder.stop}
              />
            )}

            {phase === 'recording' && <VoiceWave level={recorder.level} />}

            {/* role=alert: el lector de pantalla lo anuncia sin esperar. */}
            {error && phase === 'error' && (
              <ErrorPanel message={error} onRetry={send} onNew={newReport} />
            )}

            {phase === 'unavailable' && (
              <MicUnavailable state={recorder.state} />
            )}
          </>
        )}
      </div>

      <footer className="safe-bottom pt-4 text-center text-[13px] text-content-muted">
        Si la persona está en peligro inmediato, llama también al{' '}
        <a href="tel:123" className="text-content underline">123</a>.
      </footer>

      {modalOpen && (
        <LocationModal
          value={labelDraft}
          onChange={setLabelDraft}
          onSave={saveLabel}
          onCancel={() => setModalOpen(false)}
        />
      )}
    </main>
  );
}

function LocationBar({
  locating, position, label, onChange,
}: {
  locating: boolean;
  position: Position | null;
  label: string;
  onChange: () => void;
}) {
  let tone: 'neutral' | 'warn' | 'ok' = 'neutral';
  let text = 'Obteniendo tu ubicación…';

  if (!locating && !position) {
    tone = 'warn';
    text = 'Sin ubicación — un operador te la pedirá';
  } else if (!locating && position) {
    tone = 'ok';
    const accuracy = position.accuracyM ? ` · ±${Math.round(position.accuracyM)} m` : '';
    text = label ? `${label}${accuracy}` : `Ubicación lista${accuracy}`;
  }

  const styles = {
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    neutral: 'bg-surface-raised text-content-secondary',
  }[tone];

  return (
    <div className="flex items-center gap-2 self-start">
      <span className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-[13px] ${styles}`}>
        <LocationIcon size={16} />
        <span className="max-w-[60vw] truncate">{text}</span>
      </span>
      {position && (
        <button
          type="button"
          onClick={onChange}
          className="pressable rounded-full px-3 py-2 text-[13px] text-content hover:text-content-secondary"
        >
          Cambiar
        </button>
      )}
    </div>
  );
}

/**
 * Botón de grabación: el único elemento accionable de la pantalla.
 * 176px de diámetro, muy por encima del mínimo de 48px, porque quien lo usa
 * puede estar temblando o con una sola mano.
 */
function RecordButton({
  phase, level, seconds, onStart, onStop,
}: {
  phase: Phase;
  level: number;
  seconds: number;
  onStart: () => void;
  onStop: () => void;
}) {
  const isRecording = phase === 'recording';
  const starting = phase === 'starting';
  const busy = phase === 'sending';
  // Cerca del corte de seguridad: se avisa para que nadie se lleve la
  // sorpresa de que el audio terminó solo.
  const nearLimit = isRecording && seconds >= MAX_AUDIO_SECONDS - 10;

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
          disabled={busy || starting}
          aria-busy={busy || starting}
          aria-label={
            isRecording ? 'Detener grabación'
              : starting ? 'Activando el micrófono'
              : busy ? 'Enviando reporte'
              : 'Grabar descripción de la emergencia'
          }
          className={`pressable relative rounded-full font-semibold shadow-2xl
                     bg-emergency hover:bg-emergency-hover active:bg-emergency-pressed
                     disabled:opacity-70 text-white flex flex-col items-center justify-center gap-2
                     ${!isRecording && !starting && !busy ? 'animate-breathe' : ''}`}
          style={{ width: 176, height: 176 }}
        >
          {isRecording ? <StopIcon size={40} />
            : busy || starting ? <span className="spinner" aria-hidden />
            : <MicIcon size={44} />}
          <span className="text-[17px]">
            {isRecording
              ? <span className="tnum">{seconds.toFixed(0)}s</span>
              : starting ? 'Activando…'
              : busy ? 'Enviando…'
              : 'Grabar'}
          </span>
        </button>
      </div>

      {/* aria-live: el cambio de instrucción se anuncia al iniciar la grabación. */}
      <p aria-live="polite"
         className="text-center text-content-secondary max-w-[19rem] text-[15px] leading-relaxed">
        {isRecording
          ? nearLimit
            ? 'Llegaste al límite. Suelta el botón si quieres enviar ya.'
            : 'Suelta el botón para terminar.'
          : starting
            ? 'Pide permiso para usar el micrófono.'
            : busy
              ? 'Enviando tu reporte…'
              : 'Toca y describe la emergencia con tus palabras.'}
      </p>
    </div>
  );
}

/** Onda de voz en vivo: feedback visual de que el micrófono está captando. */
function VoiceWave({ level }: { level: number }) {
  const pathRef = useRef<SVGPathElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    let raf = 0;
    let t = 0;
    const W = 300, H = 56, base = 28;
    const step = () => {
      t += 0.18;
      const amp = 3 + levelRef.current * 18;
      let d = '';
      for (let x = 0; x <= W; x += 2) {
        const y = base + Math.sin((x / 18) + t) * amp * Math.sin((x / W) * Math.PI);
        d += `${x === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `;
      }
      if (pathRef.current) pathRef.current.setAttribute('d', d);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg width="100%" height="56" viewBox="0 0 300 56" preserveAspectRatio="none" aria-hidden>
      <path ref={pathRef} fill="none" stroke="var(--emergency)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Confirmación: la tarjeta llega como un objeto, no como texto plano, y da
 *  las dos únicas acciones que importan tras reportar: llamar o empezar de
 *  nuevo. */
function ConfirmationCard({ incident, onNew }: { incident: AudioReportResponse; onNew: () => void }) {
  return (
    <div className="w-full max-w-sm">
      <div className="rounded-md bg-white p-5 flex flex-col items-center text-center shadow-2xl animate-scale-in">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/isotipo_sin_fondo.png"
          alt="Despacho Cartagena"
          className="h-14 w-14 object-contain mb-3"
        />
        <p className="flex items-center gap-2 text-[16px] font-semibold text-gray-900">
          <CheckIcon size={18} className="text-emergency" />
          Emergencia reportada
        </p>
        <p className="mt-1 text-[13px] text-gray-600">
          Incidente <span className="tnum font-medium text-gray-900">{incident.incidentId}</span>
        </p>
        <p className="mt-2 text-[13px] text-gray-500 leading-snug">
          Tu reporte fue enviado al Despacho de Cartagena.
        </p>

        <div className="mt-5 w-full flex flex-col gap-2">
          <a
            href="tel:123"
            className="pressable w-full rounded-md bg-gray-900 hover:bg-gray-800 text-white text-[16px] font-semibold
                       flex items-center justify-center gap-2"
            style={{ minHeight: 'var(--touch-comfort)' }}
          >
            Llamar al 123
          </a>
          <button
            type="button"
            onClick={onNew}
            className="pressable w-full rounded-sm text-gray-600 hover:text-gray-900 text-[15px]"
            style={{ minHeight: 'var(--touch-min)' }}
          >
            Nuevo reporte
          </button>
        </div>
      </div>
    </div>
  );
}

function ErrorPanel({ message, onRetry, onNew }: { message: string; onRetry: () => void; onNew: () => void }) {
  return (
    <div className="w-full max-w-sm flex flex-col gap-3">
      <p role="alert" className="flex items-start gap-2 text-emergency text-[15px]">
        <AlertIcon size={18} className="mt-0.5 shrink-0" />
        <span>{message}</span>
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="pressable w-full rounded-md bg-emergency hover:bg-emergency-hover active:bg-emergency-pressed
                   text-white font-semibold text-[16px] flex items-center justify-center gap-2"
        style={{ minHeight: 'var(--touch-comfort)' }}
      >
        <RetryIcon size={18} />
        Reintentar
      </button>
      <button
        type="button"
        onClick={onNew}
        className="pressable w-full rounded-sm text-content-secondary hover:text-content text-[15px]"
        style={{ minHeight: 'var(--touch-min)' }}
      >
        Nuevo reporte
      </button>
    </div>
  );
}

/** Sin micro: se explica el motivo y se ofrece el 123. Nunca un estado mudo. */
function MicUnavailable({ state }: { state: string }) {
  return (
    <div className="w-full max-w-sm flex flex-col gap-3 text-center">
      <p role="alert" className="flex items-start gap-2 text-warn text-[15px] text-left">
        <AlertIcon size={18} className="mt-0.5 shrink-0" />
        <span>
          {state === 'denied'
            ? 'No tenemos permiso para usar el micrófono.'
            : 'Tu navegador no permite grabar audio.'}
        </span>
      </p>
      <a
        href="tel:123"
        className="pressable w-full rounded-md bg-emergency hover:bg-emergency-hover text-white font-semibold
                   text-[16px] flex items-center justify-center gap-2"
        style={{ minHeight: 'var(--touch-comfort)' }}
      >
        Llamar al 123
      </a>
    </div>
  );
}

function LocationModal({
  value, onChange, onSave, onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/70">
      <div className="w-full max-w-sm rounded-md bg-surface-raised ring-1 ring-edge-strong p-5 flex flex-col gap-4 safe-bottom animate-scale-in">
        <p className="text-[16px] font-semibold text-content">¿Dónde estás?</p>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder="Ej. Cra 13 # 26-45, Cartagena"
          autoFocus
          className="w-full rounded-sm bg-surface-base ring-1 ring-edge-subtle px-3 text-content
                     placeholder:text-content-muted text-[15px]"
          style={{ minHeight: 'var(--touch-comfort)' }}
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="pressable flex-1 rounded-sm ring-1 ring-edge-subtle text-content-secondary hover:text-content text-[15px]"
            style={{ minHeight: 'var(--touch-comfort)' }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onSave}
            className="pressable flex-1 rounded-sm bg-emergency hover:bg-emergency-hover text-white font-semibold text-[15px]"
            style={{ minHeight: 'var(--touch-comfort)' }}
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
