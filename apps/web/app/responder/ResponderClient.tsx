'use client';

import { estimateEta, type Assignment, type Incident, type VehicleWithLocation } from '@dispatch/contracts';
import { useEffect, useRef, useState } from 'react';
import { CheckIcon, LocationIcon, PhoneIcon } from '@/src/components/ui/icons';
import { Badge, Button } from '@/src/components/ui';
import { useLiveResource } from '@/src/hooks/useLiveResource';
import { useVehicleTracking, type GpsState } from './useVehicleTracking';
import { assignmentActionOutcome } from './responderState';

/** Misma unidad que UNIVERSAL_VEHICLE_ID en src/server/modules/vehicles —
 *  no hay selector ni login de unidad (§ remodel: un solo panel recibe todo
 *  sin importar cuenta ni ubicación). El navegador de este panel ES la
 *  ambulancia: reporta su GPS real bajo ese id fijo todo el tiempo. Nivel
 *  RESCUE en el seed para no quedar nunca excluida por capacidad. */
const UNIVERSAL_VEHICLE_ID = 'seed-vehicle-05';

/** Centro de Cartagena — respaldo cuando el navegador no da permiso de GPS
 *  (o tarda). Sin esto, negar el permiso deja la unidad sin ubicación fresca
 *  para siempre y el despacho nunca encuentra candidato (§ demo: que nunca
 *  se quede sin asignar por un permiso del navegador). */
const FALLBACK_LOCATION = { lat: 10.4056, lng: -75.5144 };

const GPS_LABELS: Record<GpsState, string> = {
  waiting: 'Buscando GPS', sending: 'GPS en vivo', offline: 'GPS sin conexión',
  denied: 'GPS sin permiso', unsupported: 'GPS no disponible',
};

interface ResponderCurrent {
  incident: Incident | null;
  reportSummary: string | null;
  reporterContact: string | null;
  assignment: Assignment | null;
  assignedVehicle: VehicleWithLocation | null;
}

const INITIAL: ResponderCurrent = {
  incident: null, reportSummary: null, reporterContact: null, assignment: null, assignedVehicle: null,
};

function selectCurrent(payload: unknown): ResponderCurrent {
  if (!payload || typeof payload !== 'object') throw new Error('Respuesta de despacho inválida');
  return payload as ResponderCurrent;
}

/** Hora local de Cartagena (UTC-5, sin horario de verano) — mismo cálculo
 *  que candidates.ts usa en el servidor para el perfil de velocidad. */
function cartagenaHour(): number {
  return (new Date().getUTCHours() + 19) % 24;
}

export function ResponderClient() {
  const live = useLiveResource({
    initialData: INITIAL,
    endpoint: '/api/responder/current',
    topics: ['incident:created', 'incident:merged', 'incident:updated', 'assignment:updated', 'vehicle:location'],
    select: selectCurrent,
  });
  const { incident, reportSummary, reporterContact, assignment, assignedVehicle } = live.data;
  const tracking = useVehicleTracking(UNIVERSAL_VEHICLE_ID, true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const redispatchingRef = useRef(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/responder/sw.js', { scope: '/responder/' });
  }, []);

  useEffect(() => {
    if (assignment?.status === 'OFFERED') navigator.vibrate?.([500, 180, 500, 180, 900]);
  }, [assignment?.id, assignment?.status]);

  // Late de respaldo con el centro de Cartagena: el despacho excluye una
  // unidad con ubicación de más de 5 min. Si el navegador niega el GPS o
  // tarda, esto igual mantiene la unidad "viva" para el motor de despacho —
  // en cuanto haya GPS real, sus posiciones son más recientes y ganan.
  useEffect(() => {
    const send = () => {
      void fetch(`/api/vehicles/${UNIVERSAL_VEHICLE_ID}/location`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ positions: [{ ...FALLBACK_LOCATION, recordedAt: Date.now() }] }),
      });
    };
    send();
    const timer = window.setInterval(send, 20_000);
    return () => window.clearInterval(timer);
  }, []);

  // Sin Command Center no hay humano que dispare el despacho: la primera
  // pasada corre sola en app/api/incidents/audio/route.ts. Si esa pasada no
  // encontró ninguna unidad con ubicación fresca (p. ej. este panel recién se
  // abrió), reintenta seguido hasta que haya asignación.
  useEffect(() => {
    if (!incident || assignment || redispatchingRef.current) return;
    redispatchingRef.current = true;
    const timer = window.setTimeout(() => {
      void fetch(`/api/incidents/${encodeURIComponent(incident.id)}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'AUTO_ASSIGN' }),
      }).finally(() => {
        redispatchingRef.current = false;
        void live.refresh();
      });
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [incident, assignment, live]);

  /** Acepta la oferta si hace falta y marca la unidad en camino en un solo
   *  paso — el ciudadano ya lo ve reflejado en su seguimiento en vivo. */
  const notifyEnRoute = async () => {
    if (!assignment || !assignedVehicle || busy) return;
    setBusy(true); setMessage(null);
    try {
      if (assignment.status === 'OFFERED') {
        const response = await fetch(`/api/assignments/${encodeURIComponent(assignment.id)}/accept`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        const outcome = assignmentActionOutcome(response.status);
        if (outcome.kind === 'conflict') { setMessage(outcome.message); await live.refresh(); return; }
        if (!response.ok) throw new Error('No se pudo aceptar el reporte');
      }
      const statusResponse = await fetch(`/api/vehicles/${encodeURIComponent(assignedVehicle.id)}/status`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'EN_ROUTE' }),
      });
      if (!statusResponse.ok) throw new Error('No se pudo notificar que vas en camino');
      await live.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible completar la acción');
    } finally {
      setBusy(false);
    }
  };

  const notified = Boolean(assignment && assignment.status !== 'OFFERED' && assignment.status !== 'ACCEPTED');
  const liveEta = notified && assignedVehicle?.location && incident
    ? estimateEta(assignedVehicle.location, incident, cartagenaHour())
    : null;

  return (
    <main className="app-light responder-shell">
      <ResponderHeader gps={tracking.state} queued={tracking.queued} tone={incident ? (notified ? 'green' : 'red') : 'green'} />

      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.16em] text-content-muted">{incident ? 'Reporte recibido' : 'Estado actual'}</p>
          <h1 className="text-2xl font-bold">{incident ? incidentTypeLabel(incident.type) : 'Sin reportes activos'}</h1>
        </div>
        {incident && <Badge className="bg-surface-overlay px-3 py-2 text-content-secondary">{incident.code}</Badge>}
      </div>

      <section className="state-card mt-4 overflow-hidden">
        {incident && assignedVehicle && <RouteMap vehicle={assignedVehicle} incident={incident} />}
        <div className="p-4">
          {incident ? (
            <>
              <p className="flex items-start gap-2 text-content-secondary"><LocationIcon className="mt-0.5 shrink-0 text-emergency" size={18} />{incident.address ?? 'Ubicación GPS del incidente'}</p>
              <p className="mt-2 text-sm font-semibold text-content-secondary">{incident.patientCount} paciente(s)</p>
              {/* El reporte que estructuró la IA (audio-intake.ts), tal cual — es lo único operativo que ve el responder. */}
              {reportSummary && (
                <p className="mt-3 rounded-xl bg-surface-overlay p-3 text-sm italic text-content-secondary">&ldquo;{reportSummary}&rdquo;</p>
              )}
              {!assignment && (
                <p className="mt-3 text-sm font-semibold text-info">Buscando ambulancia disponible…</p>
              )}
              {liveEta && (
                <p className="mt-3 text-sm font-bold text-ok">
                  {(liveEta.distanceM / 1000).toFixed(1)} km · llegas en ~{Math.max(1, Math.round(liveEta.etaSeconds / 60))} min
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-content-secondary">Te avisaremos apenas llegue un reporte de un ciudadano.</p>
          )}
        </div>
      </section>

      {incident && (
        <div className="mt-auto flex flex-col gap-3 pt-5">
          {/* Llamar no depende de que ya haya asignación: es el contacto del
           *  reporte, útil desde el primer segundo. */}
          {reporterContact && (
            <a href={`tel:${reporterContact}`} className="pressable flex min-h-touch-lg items-center justify-center gap-2 rounded-xl border border-edge-strong font-semibold text-info">
              <PhoneIcon size={20} /> Llamar al ciudadano
            </a>
          )}
          {assignment && (
            notified ? (
              <p className="flex items-center justify-center gap-2 rounded-xl bg-ok-soft py-3 font-semibold text-ok"><CheckIcon size={18} /> Ya avisamos que vas en camino</p>
            ) : (
              <Button className="responder-action bg-ok text-white" disabled={busy} onClick={() => void notifyEnRoute()}>Notificar: voy en camino</Button>
            )
          )}
        </div>
      )}

      {(message || live.error) && <p role="alert" className="responder-alert">{message ?? live.error?.message}</p>}
    </main>
  );
}

function ResponderHeader({ gps, queued, tone }: { gps: GpsState; queued: number; tone: 'green' | 'red' }) {
  const backgrounds = { green: 'bg-[#087f5b]', red: 'bg-[#d90429]' };
  const danger = gps !== 'sending';
  return (
    <header className={`responder-header ${backgrounds[tone]}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="px-2"><span className="block text-[10px] font-bold uppercase tracking-[.18em] opacity-75">Panel de</span><span className="block text-2xl font-bold">Ambulancia</span></div>
        <span className={`rounded-full px-3 py-2 text-xs font-bold ${danger ? 'bg-white text-emergency' : 'bg-white/18 text-white ring-1 ring-white/30'}`}>{GPS_LABELS[gps]}{queued ? ` · ${queued} en cola` : ''}</span>
      </div>
    </header>
  );
}

function RouteMap({ vehicle, incident }: { vehicle: VehicleWithLocation; incident: Incident }) {
  const bounds = { minLat: 10.38, maxLat: 10.51, minLng: -75.59, maxLng: -75.46 };
  const point = (lat: number, lng: number) => ({ x: Math.max(8, Math.min(92, ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * 100)), y: Math.max(8, Math.min(92, (1 - (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * 100)) });
  const start = vehicle.location ? point(vehicle.location.lat, vehicle.location.lng) : { x: 48, y: 48 };
  const end = point(incident.lat, incident.lng);
  return (
    <div className="responder-map relative h-64 overflow-hidden" role="img" aria-label={`Distancia entre la ambulancia y ${incident.code}`}>
      <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#1261c9" strokeWidth="2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        <circle cx={end.x} cy={end.y} r="3.4" fill="#d90429" stroke="white" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <circle cx={start.x} cy={start.y} r="4" fill="#087f5b" stroke="white" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="absolute left-3 top-3 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-content-secondary shadow">Cartagena · ruta estimada</span>
      <span className="absolute bottom-3 left-3 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-ok shadow">Tú</span>
      <span className="absolute bottom-3 right-3 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-emergency shadow">{incident.code}</span>
    </div>
  );
}

function incidentTypeLabel(type: string): string {
  const labels: Record<string, string> = { TRAFFIC_ACCIDENT: 'Accidente de tránsito', CARDIAC: 'Emergencia cardiaca', UNCONSCIOUS: 'Persona inconsciente', FALL: 'Caída o lesión', TRAUMA: 'Trauma', RESPIRATORY: 'Emergencia respiratoria', OBSTETRIC: 'Emergencia obstétrica', OTHER: 'Otra emergencia' };
  return labels[type] ?? type;
}
