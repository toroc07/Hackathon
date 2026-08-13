'use client';

import {
  TRACKING_STEP,
  type IncidentType,
  type TrackingResponse,
  type TrackingStep,
} from '@dispatch/contracts';
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { AiCallWidget } from '@/src/components/call/AiCallWidget';
import {
  AlertIcon, AmbulanceIcon, CarCrashIcon, FallIcon, HeartIcon,
  LungsIcon, TraumaIcon, UnconsciousIcon,
} from '@/src/components/ui/icons';
import { TrackingMap } from './TrackingMap';

/** Polling y no SSE: en serverless el bus de eventos vive en la memoria de una
 *  instancia y no llegaría a los clientes conectados a otra. 4s se siente vivo
 *  sin castigar batería ni datos móviles. */
const POLL_MS = 4_000;

const STEP_ORDER: readonly TrackingStep[] = TRACKING_STEP;

const LABELS: Record<TrackingStep, string> = {
  RECEIVED: 'Reporte recibido',
  ASSIGNING: 'Buscando unidad',
  ON_THE_WAY: 'Unidad en camino',
  ARRIVED: 'Unidad en el lugar',
  TRANSPORTING: 'Traslado al hospital',
  COMPLETED: 'Atención completada',
};

const CONFIRM_TYPES: Array<{ type: IncidentType; label: string; Icon: ComponentType<{ size?: number }> }> = [
  { type: 'TRAFFIC_ACCIDENT', label: 'Accidente', Icon: CarCrashIcon },
  { type: 'CARDIAC', label: 'Dolor de pecho', Icon: HeartIcon },
  { type: 'UNCONSCIOUS', label: 'Inconsciente', Icon: UnconsciousIcon },
  { type: 'FALL', label: 'Caída', Icon: FallIcon },
  { type: 'RESPIRATORY', label: 'No respira', Icon: LungsIcon },
  { type: 'TRAUMA', label: 'Herida grave', Icon: TraumaIcon },
];

export function TrackingClient({ token }: { token: string }) {
  const [tracking, setTracking] = useState<TrackingResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/track/${token}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('not-found');
      setTracking((await response.json()) as TrackingResponse);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const tick = () => { void load(); timerRef.current = window.setTimeout(tick, POLL_MS); };
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
      // Confirmar es una mejora, no un requisito: el incidente ya existe y el
      // operador puede corregir el tipo desde el centro de mando.
    }
  }, [token]);

  if (!tracking) {
    return (
      <main className="min-h-dvh flex items-center justify-center safe-x">
        <p className="text-content-secondary" role="status">
          {offline ? 'Sin conexión. Reintentando…' : 'Cargando seguimiento…'}
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh safe-x pb-10">
      <header className="safe-top pb-4">
        <p className="text-[11px] uppercase tracking-[0.14em] text-content-muted tnum">
          {tracking.incidentCode}
        </p>
        {/* aria-live: el paso cambia solo, sin que la persona toque nada. */}
        <h1 aria-live="polite" className="mt-1.5 text-[26px] font-semibold tracking-tight leading-tight">
          {tracking.headline}
        </h1>
        <p className="mt-2 text-content-secondary text-[15px] leading-relaxed">
          {tracking.detail}
        </p>
      </header>

      {tracking.etaSeconds !== null && <EtaBanner seconds={tracking.etaSeconds} />}

      <section className="mt-5">
        <TrackingMap tracking={tracking} />
      </section>

      <section className="mt-4">
        <AiCallWidget />
      </section>

      {tracking.vehicle && (
        <section className="mt-4">
          <VehicleCard
            callsign={tracking.vehicle.callsign}
            level={tracking.vehicle.capabilityLevel}
            updatedAt={tracking.vehicle.updatedAt}
            serverTime={tracking.serverTime}
            distanceM={tracking.distanceM}
          />
        </section>
      )}

      {tracking.step === 'ASSIGNING' && !confirmed && (
        <section className="mt-5">
          <ConfirmTypePanel onSelect={confirmType} />
        </section>
      )}

      <section className="mt-6">
        <Steps current={tracking.step} timeline={tracking.timeline} />
      </section>

      {tracking.reportCount > 1 && (
        <section className="mt-5">
          <p className="rounded-md bg-surface-raised ring-1 ring-edge-subtle px-4 py-3
                        text-[14px] text-content-secondary leading-relaxed">
            Otras <span className="tnum">{tracking.reportCount - 1}</span> personas reportaron
            esta misma emergencia. Se atiende como un solo incidente para no enviar varias
            ambulancias al mismo lugar.
          </p>
        </section>
      )}

      {offline && (
        <p role="status" className="mt-5 flex items-center gap-2 text-[13px] text-warn">
          <AlertIcon size={16} />
          Sin conexión con el servidor. Reintentando…
        </p>
      )}
    </main>
  );
}

/** ETA grande: es lo único que la persona mira mientras espera. */
function EtaBanner({ seconds }: { seconds: number }) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return (
    <div className="mt-2 rounded-lg bg-emergency-soft ring-1 ring-emergency-ring
                    px-5 py-4 flex items-baseline gap-3">
      <span className="text-[40px] leading-none font-semibold tnum text-emergency">
        {minutes}
      </span>
      <span className="text-content-secondary text-[15px]">min aproximadamente</span>
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
    <div className="rounded-md bg-surface-raised ring-1 ring-edge-subtle px-4 py-4
                    flex items-center gap-4">
      <span className="text-emergency shrink-0"><AmbulanceIcon size={32} /></span>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-[16px]">Unidad {callsign}</p>
        <p className="text-[13px] text-content-muted">
          {level}
          {distanceM !== null && <> · a <span className="tnum">{(distanceM / 1000).toFixed(1)}</span> km</>}
        </p>
      </div>
      <span className={`text-[12px] shrink-0 ${stale ? 'text-warn' : 'text-ok'}`}>
        {stale ? <>señal hace <span className="tnum">{ageSeconds}</span>s</> : 'en vivo'}
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
    <ol className="flex flex-col">
      {STEP_ORDER.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        const at = timeFor(step);
        return (
          <li key={step} className="flex gap-4">
            <div className="flex flex-col items-center">
              <span
                aria-hidden
                className={[
                  'h-3.5 w-3.5 rounded-full ring-4',
                  active ? 'bg-emergency ring-emergency-soft'
                    : done ? 'bg-ok ring-ok-soft'
                    : 'bg-surface-overlay ring-transparent',
                ].join(' ')}
              />
              {index < STEP_ORDER.length - 1 && (
                <span aria-hidden
                      className={`w-px flex-1 ${done ? 'bg-ok' : 'bg-edge-subtle'}`}
                      style={{ minHeight: 28, opacity: done ? 0.45 : 1 }} />
              )}
            </div>
            <div className="pb-5">
              <p className={
                active ? 'font-medium text-content'
                  : done ? 'text-content-secondary'
                  : 'text-content-muted'
              }>
                {LABELS[step]}
                {active && <span className="sr-only"> (paso actual)</span>}
              </p>
              {at && (
                <p className="text-[12px] text-content-muted tnum">
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

/** Se muestra solo si la clasificación no fue concluyente: el modelo propone,
 *  la persona confirma. Es la red de seguridad sobre la clasificación por IA. */
function ConfirmTypePanel({ onSelect }: { onSelect: (type: IncidentType) => void }) {
  return (
    <div className="rounded-md bg-warn-soft ring-1 ring-warn/30 p-4">
      <p className="flex items-start gap-2 text-warn text-[14px] mb-3">
        <AlertIcon size={18} />
        <span>No entendimos bien el audio. ¿Qué está pasando?</span>
      </p>
      <div className="grid grid-cols-3 gap-2">
        {CONFIRM_TYPES.map(({ type, label, Icon }) => (
          <button
            key={type}
            type="button"
            onClick={() => onSelect(type)}
            className="pressable rounded-sm bg-surface-raised ring-1 ring-edge-subtle
                       flex flex-col items-center justify-center gap-1.5 px-2 py-3
                       text-content-secondary"
            style={{ minHeight: 'var(--touch-comfort)' }}
          >
            <Icon size={24} />
            <span className="text-[11px] leading-tight text-center">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
