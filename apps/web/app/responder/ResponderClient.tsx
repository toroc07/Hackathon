'use client';

import { estimateEta, type Assignment, type Incident, type VehicleWithLocation } from '@dispatch/contracts';
import { useEffect, useRef, useState } from 'react';
import { AlertIcon, CheckIcon, LocationIcon, PhoneIcon } from '@/src/components/ui/icons';
import { Badge, Button } from '@/src/components/ui';
import { LiveRouteMap } from '@/src/components/map/LiveRouteMap';
import { useKeepAlive } from '@/src/hooks/useKeepAlive';
import { useLiveResource } from '@/src/hooks/useLiveResource';
import type { RouteResult } from '@/src/lib/routing';
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
  const [route, setRoute] = useState<RouteResult | null>(null);
  const redispatchingRef = useRef(false);

  useKeepAlive();

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

  // El GPS del propio dispositivo va por delante del que ya viajó al servidor:
  // para SU mapa, el conductor debe verse donde está, no donde estaba hace unos
  // segundos. La posición del servidor queda de respaldo.
  const vehiclePoint = tracking.position ?? assignedVehicle?.location ?? null;

  // La ruta del grafo manda; `estimateEta` en línea recta solo cubre el hueco
  // hasta que llega (o si el servicio de rutas está caído).
  const fallbackEta = vehiclePoint && incident
    ? estimateEta(vehiclePoint, incident, cartagenaHour())
    : null;
  const distanceKm = route ? route.distanceMeters / 1000 : fallbackEta ? fallbackEta.distanceM / 1000 : null;
  const etaMinutes = route
    ? Math.max(1, Math.round(route.durationSeconds / 60))
    : fallbackEta ? Math.max(1, Math.round(fallbackEta.etaSeconds / 60)) : null;

  return (
    <main className="app-light responder-shell">
      <ResponderHeader
        gps={tracking.state}
        queued={tracking.queued}
        tone={incident ? (notified ? 'green' : 'red') : 'slate'}
        status={incident ? (notified ? 'En camino' : 'Reporte activo') : 'En espera'}
      />

      {!incident ? (
        <IdleState gps={tracking.state} />
      ) : (
        <>
          <div className="mt-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.16em] text-emergency">
                {notified ? 'Vas en camino' : 'Reporte recibido'}
              </p>
              <h1 className="mt-0.5 text-2xl font-bold leading-tight">{incidentTypeLabel(incident.type)}</h1>
            </div>
            <Badge className="tnum shrink-0 bg-surface-overlay px-3 py-2 text-content-secondary">{incident.code}</Badge>
          </div>

          <section className="state-card mt-4 overflow-hidden">
            <LiveRouteMap
              vehicle={vehiclePoint}
              destination={{ lat: incident.lat, lng: incident.lng }}
              vehicleLabel="Tu ambulancia"
              destinationLabel={`Emergencia ${incident.code}`}
              onRoute={setRoute}
              height={264}
            />

            {/* Distancia y tiempo primero y en grande: es lo que el conductor
                mira de reojo mientras conduce. */}
            {etaMinutes !== null && (
              <div className="flex items-end gap-5 border-b border-edge-subtle px-4 py-3">
                <span className="flex items-baseline gap-1.5">
                  <span className="tnum text-4xl font-bold leading-none text-ok">{etaMinutes}</span>
                  <span className="text-sm font-bold text-content-secondary">min</span>
                </span>
                {distanceKm !== null && (
                  <span className="flex items-baseline gap-1.5">
                    <span className="tnum text-2xl font-bold leading-none">{distanceKm.toFixed(1)}</span>
                    <span className="text-sm font-bold text-content-secondary">km</span>
                  </span>
                )}
                <span className="ml-auto pb-1 text-[11px] font-semibold text-content-muted">
                  {route?.source === 'graph' ? 'por calles' : 'estimado'}
                </span>
              </div>
            )}

            <div className="p-4">
              <p className="flex items-start gap-2 font-semibold leading-snug">
                <LocationIcon className="mt-0.5 shrink-0 text-emergency" size={18} />
                {incident.address ?? 'Ubicación GPS del incidente'}
              </p>
              <p className="mt-2 text-sm font-semibold text-content-secondary">{incident.patientCount} paciente(s)</p>
              {/* El reporte que estructuró la IA (audio-intake.ts), tal cual — es lo único operativo que ve el responder. */}
              {reportSummary && (
                <p className="mt-3 rounded-xl bg-surface-overlay p-3 text-sm italic leading-relaxed text-content-secondary">
                  &ldquo;{reportSummary}&rdquo;
                </p>
              )}
              {!assignment && (
                <p className="mt-3 flex items-center gap-2 text-sm font-semibold text-info">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-info" />
                  Buscando ambulancia disponible…
                </p>
              )}
            </div>
          </section>

          <div className="mt-auto flex flex-col gap-3 pt-5">
            <div className="grid grid-cols-2 gap-3">
              {/* Navegación paso a paso: el mapa da contexto, pero al volante
                  hace falta voz. Se delega en la app que el conductor ya usa. */}
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${incident.lat},${incident.lng}&travelmode=driving`}
                target="_blank" rel="noopener noreferrer"
                className="pressable flex min-h-touch-lg items-center justify-center gap-2 rounded-xl bg-info font-bold text-white"
              >
                <LocationIcon size={19} /> Cómo llegar
              </a>
              {/* Llamar no depende de que ya haya asignación: es el contacto del
               *  reporte, útil desde el primer segundo. */}
              <a
                href={reporterContact ? `tel:${reporterContact}` : undefined}
                aria-disabled={!reporterContact}
                className={`pressable flex min-h-touch-lg items-center justify-center gap-2 rounded-xl border border-edge-strong font-bold ${reporterContact ? 'text-info' : 'pointer-events-none text-content-muted opacity-50'}`}
              >
                <PhoneIcon size={19} /> Llamar
              </a>
            </div>

            {assignment && (
              notified ? (
                <p className="flex items-center justify-center gap-2 rounded-xl bg-ok-soft py-3 font-semibold text-ok">
                  <CheckIcon size={18} /> Ya avisamos que vas en camino
                </p>
              ) : (
                <Button className="responder-action bg-ok text-white" disabled={busy} onClick={() => void notifyEnRoute()}>
                  {busy ? 'Enviando…' : 'Notificar: voy en camino'}
                </Button>
              )
            )}
          </div>
        </>
      )}

      {(message || live.error) && <p role="alert" className="responder-alert">{message ?? live.error?.message}</p>}
    </main>
  );
}

function ResponderHeader({ gps, queued, tone, status }: {
  gps: GpsState; queued: number; tone: 'green' | 'red' | 'slate'; status: string;
}) {
  const backgrounds = { green: 'bg-[#087f5b]', red: 'bg-[#d90429]', slate: 'bg-[#1f2a3d]' };
  const danger = gps !== 'sending';
  return (
    <header className={`responder-header ${backgrounds[tone]}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="px-2">
          <span className="block text-[10px] font-bold uppercase tracking-[.18em] opacity-75">Panel de</span>
          <span className="block text-2xl font-bold leading-tight">Ambulancia</span>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="rounded-full bg-white/18 px-3 py-1 text-xs font-bold text-white ring-1 ring-white/30">{status}</span>
          <span className={`rounded-full px-3 py-1 text-[11px] font-bold ${danger ? 'bg-white text-emergency' : 'bg-white/18 text-white ring-1 ring-white/30'}`}>
            {GPS_LABELS[gps]}{queued ? ` · ${queued} en cola` : ''}
          </span>
        </div>
      </div>
    </header>
  );
}

/** Sin reportes: la pantalla debe leerse de un vistazo desde el asiento del
 *  conductor y dejar claro que el panel SÍ está escuchando. Si además el GPS
 *  no está enviando, eso es lo único accionable aquí y se dice explícitamente. */
function IdleState({ gps }: { gps: GpsState }) {
  const gpsBroken = gps === 'denied' || gps === 'unsupported' || gps === 'offline';
  return (
    <section className="my-auto flex flex-col items-center py-12 text-center">
      <span className="relative grid h-24 w-24 place-items-center">
        <span className="absolute inset-0 animate-pulse-ring rounded-full bg-ok-soft" />
        <span className="relative grid h-16 w-16 place-items-center rounded-full bg-ok-soft text-ok">
          <CheckIcon size={30} />
        </span>
      </span>
      <h1 className="mt-6 text-xl font-bold">Sin reportes activos</h1>
      <p className="mt-2 max-w-xs text-sm leading-relaxed text-content-secondary">
        La unidad está disponible. Te avisamos con vibración apenas llegue un reporte de un ciudadano.
      </p>
      {gpsBroken && (
        <p className="mt-5 flex items-start gap-2 rounded-xl bg-warn-soft px-4 py-3 text-left text-sm font-semibold text-warn">
          <AlertIcon className="mt-0.5 shrink-0" size={18} />
          Sin GPS activo el despacho no puede calcular tu distancia. Permite la ubicación en el navegador.
        </p>
      )}
    </section>
  );
}

function incidentTypeLabel(type: string): string {
  const labels: Record<string, string> = { TRAFFIC_ACCIDENT: 'Accidente de tránsito', CARDIAC: 'Emergencia cardiaca', UNCONSCIOUS: 'Persona inconsciente', FALL: 'Caída o lesión', TRAUMA: 'Trauma', RESPIRATORY: 'Emergencia respiratoria', OBSTETRIC: 'Emergencia obstétrica', OTHER: 'Otra emergencia' };
  return labels[type] ?? type;
}
