'use client';

import { TRACKING_STEP, type IncidentType, type TrackingResponse, type TrackingStep } from '@dispatch/contracts';
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { AiCallWidget } from '@/src/components/call/AiCallWidget';
import { LiveRouteMap } from '@/src/components/map/LiveRouteMap';
import {
  AlertIcon, AmbulanceIcon, CarCrashIcon, CheckIcon, FallIcon, HeartIcon,
  LungsIcon, TraumaIcon, UnconsciousIcon,
} from '@/src/components/ui/icons';
import { useKeepAlive } from '@/src/hooks/useKeepAlive';
import type { RouteResult } from '@/src/lib/routing';

const POLL_MS = 4_000;
const LABELS: Record<TrackingStep, string> = {
  RECEIVED: 'Reporte recibido', ASSIGNING: 'Buscando ayuda', ON_THE_WAY: 'Ayuda en camino',
  ARRIVED: 'Unidad en el lugar', TRANSPORTING: 'Traslado en curso', COMPLETED: 'Atención completada',
};
const STEP_TONE: Record<TrackingStep, string> = {
  RECEIVED: '#e44b23', ASSIGNING: '#e6aa12', ON_THE_WAY: '#1684d6',
  ARRIVED: '#6634ad', TRANSPORTING: '#087f5b', COMPLETED: '#087f5b',
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
  const [confirming, setConfirming] = useState(false);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const timerRef = useRef<number | null>(null);

  useKeepAlive();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/track/${token}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('not-found');
      setTracking((await response.json()) as TrackingResponse);
      setOffline(false);
    } catch { setOffline(true); }
  }, [token]);

  useEffect(() => {
    void load();
    const tick = () => { void load(); timerRef.current = window.setTimeout(tick, POLL_MS); };
    timerRef.current = window.setTimeout(tick, POLL_MS);
    return () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); };
  }, [load]);

  const confirmType = useCallback(async (type: IncidentType) => {
    setConfirming(true);
    try {
      const response = await fetch(`/api/track/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }),
      });
      if (!response.ok) throw new Error('confirmation-failed');
      setTracking((await response.json()) as TrackingResponse);
      setConfirmed(true);
    } catch { setOffline(true); } finally { setConfirming(false); }
  }, [token]);

  if (!tracking) {
    return <main className="app-light mobile-app-shell safe-x flex items-center justify-center"><div className="text-center" role="status"><span className="mx-auto block h-10 w-10 animate-spin rounded-full border-4 border-edge-subtle border-t-emergency" /><p className="mt-4 text-content-secondary">{offline ? 'Sin conexión. Reintentando…' : 'Preparando tu seguimiento…'}</p></div></main>;
  }

  const currentIndex = TRACKING_STEP.indexOf(tracking.step);
  return (
    <main className="app-light mobile-app-shell safe-x pb-10">
      <header className="safe-top pb-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-bold uppercase tracking-[.16em] text-content-muted">Emergencia · <span className="tnum">{tracking.incidentCode}</span></p>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${offline ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'}`}>{offline ? 'Reconectando' : 'En vivo'}</span>
        </div>
        <ProgressStrip currentIndex={currentIndex} />
      </header>

      <StatusHero tracking={tracking} />

      <section className="mt-4 overflow-hidden rounded-2xl border border-edge-subtle bg-surface-raised shadow-sm">
        <LiveRouteMap
          vehicle={tracking.vehicle ? { lat: tracking.vehicle.lat, lng: tracking.vehicle.lng } : null}
          destination={{ lat: tracking.incidentLat, lng: tracking.incidentLng }}
          vehicleLabel={tracking.vehicle ? `Ambulancia ${tracking.vehicle.callsign}` : undefined}
          destinationLabel="Tu ubicación"
          onRoute={setRoute}
          height={320}
        />
      </section>

      <section className="mt-4">
        <AiCallWidget />
      </section>

      {tracking.vehicle && <VehicleCard tracking={tracking} route={route} />}

      {tracking.step === 'ASSIGNING' && !confirmed && (
        <ConfirmTypePanel disabled={confirming} onSelect={confirmType} />
      )}

      <Timeline current={tracking.step} timeline={tracking.timeline} />

      {tracking.reportCount > 1 && (
        <p className="mt-4 rounded-xl border border-info/20 bg-info-soft px-4 py-3 text-sm leading-relaxed text-info">
          <strong>Tu reporte sí contó.</strong> Otras <span className="tnum">{tracking.reportCount - 1}</span> personas avisaron de la misma emergencia y el sistema las agrupó para enviar una sola unidad.
        </p>
      )}

      {offline && <p role="status" className="mt-4 flex items-center gap-2 rounded-xl bg-warn-soft p-3 text-sm text-warn"><AlertIcon size={18} /> Mostrando la última actualización disponible. Reintentando…</p>}

      <a href="tel:123" className="mt-5 flex min-h-touch items-center justify-center rounded-xl border border-edge-strong font-semibold text-content-secondary">Llamar al 123</a>
    </main>
  );
}

function ProgressStrip({ currentIndex }: { currentIndex: number }) {
  return (
    <div className="mt-5" aria-label={`Paso ${currentIndex + 1} de ${TRACKING_STEP.length}: ${LABELS[TRACKING_STEP[currentIndex]]}`}>
      <div className="flex items-center">
        {TRACKING_STEP.map((step, index) => <div key={step} className="flex flex-1 items-center last:flex-none"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: index <= currentIndex ? STEP_TONE[step] : '#c8d0dc' }}>{index < currentIndex ? <CheckIcon size={15} /> : index + 1}</span>{index < TRACKING_STEP.length - 1 && <span className="h-1 flex-1" style={{ backgroundColor: index < currentIndex ? STEP_TONE[TRACKING_STEP[index + 1]] : '#dce2ea' }} />}</div>)}
      </div>
      <p className="mt-2 text-center text-xs font-semibold text-content-secondary">{LABELS[TRACKING_STEP[currentIndex]]}</p>
    </div>
  );
}

function StatusHero({ tracking }: { tracking: TrackingResponse }) {
  const minutes = tracking.etaSeconds === null ? null : Math.max(1, Math.round(tracking.etaSeconds / 60));
  return (
    <section className="overflow-hidden rounded-2xl text-white shadow-lg" style={{ background: `linear-gradient(145deg, ${STEP_TONE[tracking.step]}, ${STEP_TONE[tracking.step]}dd)` }}>
      <div className="p-5">
        <p className="text-xs font-bold uppercase tracking-[.16em] opacity-80">{LABELS[tracking.step]}</p>
        {minutes !== null && <p className="mt-2 flex items-baseline gap-2"><span className="tnum text-5xl font-bold leading-none">{minutes}</span><span className="text-lg font-semibold">min aprox.</span></p>}
        <h1 aria-live="polite" className="mt-3 text-2xl font-bold leading-tight">{tracking.headline}</h1>
        <p className="mt-2 text-sm leading-relaxed opacity-90">{tracking.detail}</p>
      </div>
    </section>
  );
}

function VehicleCard({ tracking, route }: { tracking: TrackingResponse; route: RouteResult | null }) {
  if (!tracking.vehicle) return null;
  const age = Math.max(0, Math.round((tracking.serverTime - tracking.vehicle.updatedAt) / 1000));
  const stale = age > 30;
  // La distancia por calles del grafo manda sobre la estimación en línea recta
  // del servidor cuando existe: es la que el conductor va a recorrer de verdad.
  const distance = route?.source === 'graph'
    ? `${(route.distanceMeters / 1000).toFixed(1)} km por calles`
    : tracking.distanceM !== null ? `${(tracking.distanceM / 1000).toFixed(1)} km` : null;
  return (
    <section className="state-card mt-4 flex items-center gap-4 p-4">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-emergency-soft text-emergency"><AmbulanceIcon size={29} /></span>
      <div className="min-w-0 flex-1"><h2 className="font-bold">Ambulancia {tracking.vehicle.callsign}</h2><p className="text-sm text-content-muted">{tracking.vehicle.capabilityLevel}{distance ? ` · ${distance}` : ''}</p></div>
      <span className={`text-xs font-semibold ${stale ? 'text-warn' : 'text-ok'}`}>{stale ? `GPS hace ${age}s` : 'GPS en vivo'}</span>
    </section>
  );
}

function ConfirmTypePanel({ onSelect, disabled }: { onSelect: (type: IncidentType) => void; disabled: boolean }) {
  return (
    <section className="mt-4 rounded-2xl border border-warn/30 bg-warn-soft p-4" aria-labelledby="tracking-confirm-title">
      <h2 id="tracking-confirm-title" className="flex items-center gap-2 font-bold text-warn"><AlertIcon size={19} /> Ayúdanos a confirmar</h2>
      <p className="mt-1 text-sm text-content-secondary">El audio no fue concluyente. ¿Qué está pasando?</p>
      <div className="mt-3 grid grid-cols-3 gap-2">{CONFIRM_TYPES.map(({ type, label, Icon }) => <button disabled={disabled} key={type} type="button" onClick={() => onSelect(type)} className="pressable flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-xl bg-surface-base p-2 text-content-secondary ring-1 ring-edge-subtle disabled:opacity-50"><Icon size={23} /><span className="text-center text-[11px] font-semibold leading-tight">{label}</span></button>)}</div>
    </section>
  );
}

function Timeline({ current, timeline }: { current: TrackingStep; timeline: TrackingResponse['timeline'] }) {
  const currentIndex = TRACKING_STEP.indexOf(current);
  return (
    <section className="mt-5" aria-labelledby="timeline-title"><h2 id="timeline-title" className="text-lg font-bold">Qué está pasando</h2><ol className="mt-3 space-y-2">{TRACKING_STEP.slice(0, Math.max(2, currentIndex + 1)).map((step, index) => { const entry = timeline.find((item) => item.step === step); const active = index === currentIndex; return <li key={step} className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${active ? 'border-info/30 bg-info-soft' : 'border-edge-subtle bg-surface-raised'}`}><span className={`grid h-7 w-7 place-items-center rounded-full ${index < currentIndex ? 'bg-ok text-white' : active ? 'bg-info text-white' : 'bg-surface-overlay text-content-muted'}`}>{index < currentIndex ? <CheckIcon size={16} /> : index + 1}</span><span className="flex-1 text-sm font-semibold">{LABELS[step]}</span>{entry && <time className="tnum text-xs text-content-muted">{new Date(entry.at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}</time>}</li>; })}</ol></section>
  );
}
