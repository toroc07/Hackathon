'use client';

import {
  TRACKING_STEP,
  type IncidentType,
  type TrackingResponse,
  type TrackingStep,
} from '@dispatch/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TrackingMap } from './TrackingMap';

/** Polling y no SSE: en serverless el bus de eventos vive en la memoria de una
 *  instancia y no llegaria a los clientes conectados a otra. 4s es suficiente
 *  para que se sienta vivo sin castigar la bateria ni los datos. */
const POLL_MS = 4_000;

const STEP_ORDER: readonly TrackingStep[] = TRACKING_STEP;

const CONFIRM_TYPES: Array<{ type: IncidentType; label: string; icon: string }> = [
  { type: 'TRAFFIC_ACCIDENT', label: 'Accidente', icon: '🚗' },
  { type: 'CARDIAC', label: 'Dolor de pecho', icon: '❤️' },
  { type: 'UNCONSCIOUS', label: 'Inconsciente', icon: '😶' },
  { type: 'FALL', label: 'Caída', icon: '🤕' },
  { type: 'RESPIRATORY', label: 'No respira bien', icon: '🫁' },
  { type: 'TRAUMA', label: 'Herida grave', icon: '🩸' },
];

export function TrackingClient({ token, needsConfirmation }: {
  token: string;
  needsConfirmation?: boolean;
}) {
  const [tracking, setTracking] = useState<TrackingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(!needsConfirmation);
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/track/${token}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('No encontramos este seguimiento');
      setTracking((await response.json()) as TrackingResponse);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Error de conexión');
    }
  }, [token]);

  useEffect(() => {
    void load();
    const tick = () => {
      void load();
      timerRef.current = window.setTimeout(tick, POLL_MS);
    };
    timerRef.current = window.setTimeout(tick, POLL_MS);
    return () => { if (timerRef.current !== null) clearTimeout(timerRef.current); };
  }, [load]);

  const confirmType = useCallback(async (type: IncidentType) => {
    setConfirmed(true);
    try {
      const response = await fetch(`/api/track/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      if (response.ok) setTracking((await response.json()) as TrackingResponse);
    } catch {
      // Confirmar es una mejora, no un requisito: el incidente ya existe y un
      // operador puede corregir el tipo desde el centro de mando.
    }
  }, [token]);

  if (!tracking) {
    return (
      <main className="min-h-dvh bg-slate-950 text-slate-100 flex items-center justify-center px-6">
        <p className="text-slate-400">{error ?? 'Cargando seguimiento…'}</p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-slate-950 text-slate-100 pb-10">
      <header className="px-6 pt-8 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">
          {tracking.incidentCode}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{tracking.headline}</h1>
        <p className="mt-2 text-slate-400 text-sm leading-relaxed">{tracking.detail}</p>
      </header>

      {tracking.etaSeconds !== null && <EtaBanner seconds={tracking.etaSeconds} />}

      <section className="px-6 mt-5">
        <TrackingMap tracking={tracking} />
      </section>

      {tracking.vehicle && (
        <section className="px-6 mt-4">
          <VehicleCard
            callsign={tracking.vehicle.callsign}
            level={tracking.vehicle.capabilityLevel}
            updatedAt={tracking.vehicle.updatedAt}
            serverTime={tracking.serverTime}
            distanceM={tracking.distanceM}
          />
        </section>
      )}

      {!confirmed && (
        <section className="px-6 mt-5">
          <ConfirmTypePanel onSelect={confirmType} />
        </section>
      )}

      <section className="px-6 mt-6">
        <Steps current={tracking.step} timeline={tracking.timeline} />
      </section>

      {tracking.reportCount > 1 && (
        <section className="px-6 mt-6">
          <p className="rounded-xl bg-slate-900 ring-1 ring-slate-800 px-4 py-3 text-sm text-slate-300">
            Otras {tracking.reportCount - 1} personas reportaron esta misma emergencia.
            Se atiende como un solo incidente para no enviar varias ambulancias al mismo lugar.
          </p>
        </section>
      )}

      {error && (
        <p className="px-6 mt-5 text-xs text-amber-400">
          Sin conexión con el servidor. Reintentando…
        </p>
      )}
    </main>
  );
}

/** ETA grande y en cuenta atrás: es lo único que la persona mira. */
function EtaBanner({ seconds }: { seconds: number }) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return (
    <div className="mx-6 mt-2 rounded-2xl bg-rose-500/10 ring-1 ring-rose-500/30 px-5 py-4
                    flex items-baseline gap-3">
      <span className="text-4xl font-semibold tabular-nums text-rose-300">{minutes}</span>
      <span className="text-rose-200/80">min aproximadamente</span>
    </div>
  );
}

function VehicleCard({
  callsign, level, updatedAt, serverTime, distanceM,
}: {
  callsign: string; level: string; updatedAt: number; serverTime: number;
  distanceM: number | null;
}) {
  const ageSeconds = Math.max(0, Math.round((serverTime - updatedAt) / 1000));
  // Se muestra la antigüedad de la posición: si el GPS se congela, la persona
  // debe saberlo en vez de ver un punto quieto y creer que la ambulancia paró.
  const stale = ageSeconds > 30;

  return (
    <div className="rounded-2xl bg-slate-900 ring-1 ring-slate-800 px-5 py-4 flex items-center gap-4">
      <span className="text-3xl">🚑</span>
      <div className="flex-1">
        <p className="font-semibold">Unidad {callsign}</p>
        <p className="text-sm text-slate-400">
          {level}
          {distanceM !== null && ` · a ${(distanceM / 1000).toFixed(1)} km`}
        </p>
      </div>
      <span className={`text-xs ${stale ? 'text-amber-400' : 'text-emerald-400'}`}>
        {stale ? `señal hace ${ageSeconds}s` : 'en vivo'}
      </span>
    </div>
  );
}

function Steps({
  current, timeline,
}: {
  current: TrackingStep; timeline: TrackingResponse['timeline'];
}) {
  const currentIndex = STEP_ORDER.indexOf(current);
  const timeFor = (step: TrackingStep) => timeline.find((entry) => entry.step === step)?.at;

  return (
    <ol className="flex flex-col gap-0">
      {STEP_ORDER.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        const at = timeFor(step);
        return (
          <li key={step} className="flex gap-4">
            <div className="flex flex-col items-center">
              <span
                className={[
                  'h-3.5 w-3.5 rounded-full ring-4 transition',
                  active ? 'bg-rose-400 ring-rose-500/25'
                    : done ? 'bg-emerald-400 ring-emerald-500/20'
                    : 'bg-slate-700 ring-transparent',
                ].join(' ')}
              />
              {index < STEP_ORDER.length - 1 && (
                <span className={`w-px flex-1 ${done ? 'bg-emerald-500/40' : 'bg-slate-800'}`}
                      style={{ minHeight: 28 }} />
              )}
            </div>
            <div className="pb-5">
              <p className={active ? 'font-medium text-white' : done ? 'text-slate-300' : 'text-slate-600'}>
                {LABELS[step]}
              </p>
              {at && (
                <p className="text-xs text-slate-500 tabular-nums">
                  {new Date(at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const LABELS: Record<TrackingStep, string> = {
  RECEIVED: 'Reporte recibido',
  ASSIGNING: 'Buscando unidad',
  ON_THE_WAY: 'Unidad en camino',
  ARRIVED: 'Unidad en el lugar',
  TRANSPORTING: 'Traslado al hospital',
  COMPLETED: 'Atención completada',
};

/** Se muestra solo si la transcripción no fue concluyente. Es la red de
 *  seguridad del §24: el modelo propone, la persona confirma. */
function ConfirmTypePanel({ onSelect }: { onSelect: (type: IncidentType) => void }) {
  return (
    <div className="rounded-2xl bg-amber-500/10 ring-1 ring-amber-500/30 p-4">
      <p className="text-sm text-amber-200 mb-3">
        No entendimos bien el audio. ¿Qué está pasando?
      </p>
      <div className="grid grid-cols-3 gap-2">
        {CONFIRM_TYPES.map((option) => (
          <button
            key={option.type}
            type="button"
            onClick={() => onSelect(option.type)}
            className="rounded-xl bg-slate-900 ring-1 ring-slate-800 hover:ring-amber-400/60
                       px-2 py-3 text-center transition"
          >
            <span className="block text-2xl mb-1">{option.icon}</span>
            <span className="text-[11px] text-slate-300 leading-tight block">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
