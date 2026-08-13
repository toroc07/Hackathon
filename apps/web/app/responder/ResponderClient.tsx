'use client';

import {
  MOCK_FACILITIES, REJECT_REASON,
  type ApiError, type AssignmentStatus, type Incident, type RejectReason, type VehicleWithLocation,
} from '@dispatch/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertIcon, AmbulanceIcon, CheckIcon, LocationIcon } from '@/src/components/ui/icons';
import { Badge, Button } from '@/src/components/ui';
import { useLiveVehicles } from '@/src/hooks/useLiveVehicles';
import { useResponderVehicle } from '@/src/hooks/useResponderVehicle';
import { SlideToConfirm } from './SlideToConfirm';
import { useVehicleTracking, type GpsState } from './useVehicleTracking';
import { assignmentActionOutcome } from './responderState';

const REASON_LABELS: Record<RejectReason, string> = {
  MECHANICAL: 'Falla mecánica', CREW_UNAVAILABLE: 'Tripulación no disponible',
  ALREADY_COMMITTED: 'Ya comprometida', UNSAFE_ACCESS: 'Acceso inseguro', OTHER: 'Otro motivo',
};
const GPS_LABELS: Record<GpsState, string> = {
  waiting: 'Buscando GPS', sending: 'GPS en vivo', offline: 'GPS sin conexión',
  denied: 'GPS sin permiso', unsupported: 'GPS no disponible',
};

function useSelectedVehicle(vehicles: VehicleWithLocation[]) {
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [mustChoose, setMustChoose] = useState(false);
  useEffect(() => {
    if (!vehicles.length) return;
    const queryId = new URLSearchParams(window.location.search).get('vehicleId');
    const saved = localStorage.getItem('dispatch:responder-vehicle');
    const selected = [queryId, saved].find((id) => id && vehicles.some((vehicle) => vehicle.id === id));
    if (selected) { setVehicleId(selected); setMustChoose(false); return; }
    if (vehicles.length === 1) { setVehicleId(vehicles[0].id); setMustChoose(false); return; }
    setMustChoose(true);
  }, [vehicles]);
  const select = (id: string) => { localStorage.setItem('dispatch:responder-vehicle', id); setVehicleId(id); setMustChoose(false); };
  const change = () => { localStorage.removeItem('dispatch:responder-vehicle'); setVehicleId(null); setMustChoose(true); };
  return { vehicleId, mustChoose, select, change };
}

export function ResponderClient() {
  const liveVehicles = useLiveVehicles();
  const selected = useSelectedVehicle(liveVehicles.data);
  const live = useResponderVehicle(selected.vehicleId);
  const vehicle = live.data.vehicle;
  const serverContext = live.data.activeAssignment;
  const tracking = useVehicleTracking(selected.vehicleId, Boolean(vehicle?.activeShiftId));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<RejectReason>('OTHER');
  const [destinationId, setDestinationId] = useState(MOCK_FACILITIES.find((facility) => facility.type === 'HOSPITAL')?.id ?? 'f-bocagrande');
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [lostAssignmentId, setLostAssignmentId] = useState<string | null>(null);
  const acceptedRef = useRef<Set<string>>(new Set());
  const context = serverContext?.assignment.id === lostAssignmentId ? null : serverContext;
  const destination = MOCK_FACILITIES.find((facility) => facility.id === destinationId) ?? null;

  useEffect(() => { if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/responder/sw.js', { scope: '/responder/' }); }, []);
  useEffect(() => { if (serverContext && serverContext.assignment.id !== lostAssignmentId) setLostAssignmentId(null); }, [lostAssignmentId, serverContext]);

  const offer = context?.assignment.status === 'OFFERED' ? context.assignment : null;
  useEffect(() => {
    if (!offer) return;
    navigator.vibrate?.([500, 180, 500, 180, 900]);
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((offer.expiresAt - Date.now()) / 1_000)));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [offer]);
  useEffect(() => { if (offer && secondsLeft === 0) void live.refresh(); }, [live.refresh, offer, secondsLeft]);

  const assignmentStatus = context?.assignment.status;
  const action = async (path: string, body?: unknown, idempotent = false) => {
    if (!context || busy) return false;
    const assignmentId = context.assignment.id;
    if (idempotent && acceptedRef.current.has(assignmentId)) return false;
    if (idempotent) acceptedRef.current.add(assignmentId);
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/assignments/${encodeURIComponent(assignmentId)}/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': `responder-${assignmentId}-${path}` }, body: JSON.stringify(body ?? {}),
      });
      const outcome = assignmentActionOutcome(response.status);
      if (outcome.kind === 'conflict') { setLostAssignmentId(assignmentId); setMessage(outcome.message); await live.refresh(); return false; }
      if (!response.ok) { const payload = await response.json().catch(() => null) as ApiError | null; throw new Error(payload?.error.message ?? `Error HTTP ${response.status}`); }
      await live.refresh(); return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : 'No fue posible completar la acción'); return false; }
    finally { if (idempotent) acceptedRef.current.delete(assignmentId); setBusy(false); }
  };

  const updateVehicle = async (path: string, init: RequestInit) => {
    if (!vehicle || busy) return;
    setBusy(true); setMessage(null);
    try { const response = await fetch(`/api/vehicles/${vehicle.id}/${path}`, init); if (!response.ok) throw new Error('No se pudo actualizar la unidad'); await live.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'No se pudo actualizar la unidad'); }
    finally { setBusy(false); }
  };

  const statusLabel = useMemo(() => {
    const labels: Partial<Record<AssignmentStatus, string>> = {
      OFFERED: 'Nueva asignación', ACCEPTED: 'Asignación aceptada', EN_ROUTE: 'En ruta',
      ON_SCENE: 'En el lugar', TRANSPORTING: 'Traslado en curso', COMPLETED: 'Servicio finalizado',
    };
    return lostAssignmentId ? 'Disponible' : assignmentStatus ? labels[assignmentStatus] ?? assignmentStatus : vehicle?.status === 'AVAILABLE' ? 'Disponible' : vehicle?.status ?? 'Cargando';
  }, [assignmentStatus, lostAssignmentId, vehicle?.status]);

  if (liveVehicles.error && liveVehicles.data.length === 0) {
    return (
      <main className="app-light responder-shell items-center justify-center text-center">
        <span className="grid h-16 w-16 place-items-center rounded-2xl bg-warn-soft text-warn"><AlertIcon size={34} /></span>
        <h1 className="mt-5 text-2xl font-bold">No pudimos cargar las unidades</h1>
        <p className="mt-2 max-w-sm text-content-secondary">Revisa la conexión con el centro de despacho. La app seguirá intentando conectarse.</p>
        <Button className="mt-5 min-h-touch-lg w-full bg-info text-white" onClick={() => void liveVehicles.refresh()}>Reintentar conexión</Button>
      </main>
    );
  }

  if (selected.mustChoose) return <VehiclePicker vehicles={liveVehicles.data} onSelect={selected.select} />;
  if (!selected.vehicleId || !vehicle) return <main className="app-light responder-shell items-center justify-center"><p role="status" className="text-lg font-bold">Cargando unidad…</p></main>;

  if (!vehicle.activeShiftId || vehicle.status === 'OFFLINE') {
    return (
      <main className="app-light responder-shell">
        <ResponderHeader callsign={vehicle.callsign} gps={tracking.state} queued={tracking.queued} tone="green" onChange={selected.change} />
        <section className="flex flex-1 flex-col justify-center py-10 text-center"><span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-surface-overlay text-content-secondary"><AmbulanceIcon size={36} /></span><p className="mt-5 text-sm font-bold uppercase tracking-[.16em] text-content-muted">Turno cerrado</p><h1 className="mt-2 text-3xl font-bold">Unidad fuera de servicio</h1><p className="mt-2 text-content-secondary">Inicia el turno para recibir asignaciones.</p></section>
        <Button className="responder-action bg-ok text-white" disabled={busy} onClick={() => void updateVehicle('shift/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ crewUserIds: [] }) })}>Iniciar turno</Button>
        {message && <p role="alert" className="responder-alert">{message}</p>}
      </main>
    );
  }

  if (offer && context) {
    return (
      <main className="app-light responder-shell">
        <ResponderHeader callsign={vehicle.callsign} gps={tracking.state} queued={tracking.queued} tone="red" onChange={selected.change} />
        <div className="mt-4 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-emergency">Nueva asignación</p><h1 className="text-2xl font-bold">Prioridad {context.incident.priority ?? 'por confirmar'}</h1></div><span className="tnum rounded-2xl bg-emergency px-4 py-2 text-2xl font-bold text-white" aria-label={`${secondsLeft} segundos para responder`}>{secondsLeft}s</span></div>
        <section className="state-card mt-4 overflow-hidden">
          <RouteMap vehicle={vehicle} incident={context.incident} />
          <div className="p-5"><p className="text-xs font-bold uppercase tracking-[.14em] text-content-muted">{context.incident.code}</p><h2 className="mt-1 text-2xl font-bold">{incidentTypeLabel(context.incident.type)}</h2><p className="mt-3 flex items-start gap-2 text-content-secondary"><LocationIcon className="mt-0.5 shrink-0 text-emergency" size={19} />{context.incident.address ?? 'Ubicación GPS del incidente'}</p><p className="mt-3 text-sm font-semibold text-content-secondary">{context.incident.patientCount} paciente(s) confirmado(s)</p></div>
        </section>
        <Button className="responder-action mt-4 bg-emergency text-white" disabled={busy || secondsLeft === 0} onClick={() => void action('accept', {}, true)}>Aceptar asignación</Button>
        <details className="mt-3 rounded-xl border border-edge-subtle bg-surface-raised p-3"><summary className="min-h-touch cursor-pointer py-3 font-semibold text-content-secondary">No puedo atender esta emergencia</summary><label className="mt-2 block text-sm font-semibold">Motivo<select className="mt-2 w-full rounded-xl border border-edge-strong bg-surface-base px-4 text-content" value={rejectReason} onChange={(event) => setRejectReason(event.target.value as RejectReason)}>{REJECT_REASON.map((reason) => <option key={reason} value={reason}>{REASON_LABELS[reason]}</option>)}</select></label><div className="mt-3"><SlideToConfirm disabled={busy} label={`Rechazar · ${REASON_LABELS[rejectReason]}`} onConfirm={() => void action('reject', { reason: rejectReason })} /></div></details>
        {message && <p role="alert" className="responder-alert">{message}</p>}
      </main>
    );
  }

  return (
    <main className="app-light responder-shell">
      <ResponderHeader callsign={vehicle.callsign} gps={tracking.state} queued={tracking.queued} tone={assignmentStatus === 'ON_SCENE' ? 'purple' : assignmentStatus === 'TRANSPORTING' ? 'blue' : 'green'} onChange={selected.change} />
      <div className="mt-4 flex items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-content-muted">Estado actual</p><h1 className="text-2xl font-bold">{statusLabel}</h1></div>{context && <Badge className="bg-surface-overlay px-3 py-2 text-content-secondary">{context.incident.code}</Badge>}</div>

      <section className="state-card mt-4 overflow-hidden">
        <RouteMap vehicle={vehicle} incident={context?.incident ?? null} destination={assignmentStatus === 'TRANSPORTING' ? destination : null} />
        <div className="p-4">
          {context ? <><h2 className="text-xl font-bold">{assignmentStatus === 'TRANSPORTING' ? destination?.name ?? 'Centro asistencial' : context.incident.address ?? 'Ubicación del incidente'}</h2><p className="mt-1 text-sm text-content-secondary">{incidentTypeLabel(context.incident.type)} · {context.incident.patientCount} paciente(s)</p></> : <><h2 className="text-xl font-bold">Disponible para asignaciones</h2><p className="mt-1 text-sm text-content-secondary">Te avisaremos inmediatamente cuando llegue una emergencia.</p></>}
        </div>
      </section>

      <div className="mt-auto pt-5">
        {assignmentStatus === 'ACCEPTED' && <Button className="responder-action bg-ok text-white" disabled={busy} onClick={() => void updateVehicle('status', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'EN_ROUTE' }) })}>Iniciar ruta</Button>}
        {assignmentStatus === 'EN_ROUTE' && context && <><a role="button" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${context.incident.lat},${context.incident.lng}`} className="mb-3 flex w-full items-center justify-center rounded-xl border border-edge-strong font-semibold text-info">Abrir navegación</a><Button className="responder-action bg-warn text-slate-950" disabled={busy} onClick={() => void action('arrive')}>Llegué al sitio</Button></>}
        {assignmentStatus === 'ON_SCENE' && <div><label className="block text-sm font-semibold text-content-secondary">Destino del traslado<select className="mt-2 w-full rounded-xl border border-edge-strong bg-surface-base px-4 text-content" value={destinationId} onChange={(event) => setDestinationId(event.target.value)}>{MOCK_FACILITIES.filter((facility) => facility.type !== 'BASE').map((facility) => <option key={facility.id} value={facility.id}>{facility.name}</option>)}</select></label><Button className="responder-action mt-3 bg-[#6634ad] text-white" disabled={busy} onClick={() => void action('transport', { destinationFacilityId: destinationId })}>Iniciar traslado</Button></div>}
        {assignmentStatus === 'TRANSPORTING' && <><a role="button" target="_blank" rel="noreferrer" href={destination ? `https://www.google.com/maps/dir/?api=1&destination=${destination.lat},${destination.lng}` : '#'} className="mb-3 flex w-full items-center justify-center rounded-xl border border-edge-strong font-semibold text-info">Navegar al destino</a><SlideToConfirm disabled={busy} label="Paciente entregado · cerrar servicio" large onConfirm={() => void action('complete')} /></>}
        {!context && <SlideToConfirm disabled={busy} label="Cerrar turno" large onConfirm={() => void updateVehicle('shift/end', { method: 'POST' })} />}
      </div>
      {message && <p role="alert" className="responder-alert">{message}</p>}
    </main>
  );
}

function VehiclePicker({ vehicles, onSelect }: { vehicles: VehicleWithLocation[]; onSelect: (id: string) => void }) {
  return <main className="app-light responder-shell"><header className="safe-top"><p className="text-xs font-bold uppercase tracking-[.16em] text-ok">App ambulancia</p><h1 className="mt-2 text-3xl font-bold">Selecciona tu unidad</h1><p className="mt-2 text-content-secondary">Esta selección queda guardada en el dispositivo.</p></header><div className="mt-6 grid gap-3">{vehicles.slice(0, 12).map((vehicle) => <button key={vehicle.id} type="button" onClick={() => onSelect(vehicle.id)} className="state-card pressable flex min-h-touch-lg items-center gap-4 p-4 text-left"><span className="grid h-12 w-12 place-items-center rounded-xl bg-ok-soft text-ok"><AmbulanceIcon size={28} /></span><span className="flex-1"><strong className="block text-lg">{vehicle.callsign}</strong><span className="text-sm text-content-muted">{vehicle.capabilityLevel} · {vehicle.status}</span></span></button>)}</div></main>;
}

function ResponderHeader({ callsign, gps, queued, tone, onChange }: { callsign: string; gps: GpsState; queued: number; tone: 'green' | 'red' | 'purple' | 'blue'; onChange: () => void }) {
  const backgrounds = { green: 'bg-[#087f5b]', red: 'bg-[#d90429]', purple: 'bg-[#6634ad]', blue: 'bg-[#1261c9]' };
  const danger = gps !== 'sending';
  return <header className={`responder-header ${backgrounds[tone]}`}><div className="flex items-center justify-between gap-3"><button type="button" onClick={onChange} className="rounded-xl px-2 text-left"><span className="block text-[10px] font-bold uppercase tracking-[.18em] opacity-75">Unidad</span><span className="block text-2xl font-bold">{callsign}</span></button><span className={`rounded-full px-3 py-2 text-xs font-bold ${danger ? 'bg-white text-emergency' : 'bg-white/18 text-white ring-1 ring-white/30'}`}>{GPS_LABELS[gps]}{queued ? ` · ${queued} en cola` : ''}</span></div></header>;
}

function RouteMap({ vehicle, incident, destination }: { vehicle: VehicleWithLocation; incident: Incident | null; destination?: { lat: number; lng: number; name: string } | null }) {
  const target = destination ?? incident;
  const bounds = { minLat: 10.38, maxLat: 10.51, minLng: -75.59, maxLng: -75.46 };
  const point = (lat: number, lng: number) => ({ x: Math.max(8, Math.min(92, ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * 100)), y: Math.max(8, Math.min(92, (1 - (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * 100)) });
  const start = vehicle.location ? point(vehicle.location.lat, vehicle.location.lng) : { x: 48, y: 48 };
  const end = target ? point(target.lat, target.lng) : null;
  return <div className="responder-map relative h-64 overflow-hidden" role="img" aria-label={target ? `Trayecto estimado desde ${vehicle.callsign} hasta ${destination?.name ?? 'el incidente'}` : `Ubicación actual de ${vehicle.callsign}`}><svg aria-hidden className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">{end && <><line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#1261c9" strokeWidth="2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" /><circle cx={end.x} cy={end.y} r="3.4" fill="#d90429" stroke="white" strokeWidth="1.2" vectorEffect="non-scaling-stroke" /></>}<circle cx={start.x} cy={start.y} r="4" fill="#087f5b" stroke="white" strokeWidth="1.2" vectorEffect="non-scaling-stroke" /></svg><span className="absolute left-3 top-3 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-content-secondary shadow">Cartagena · ruta estimada</span><span className="absolute bottom-3 left-3 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-ok shadow">{vehicle.callsign}</span>{target && <span className="absolute bottom-3 right-3 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-emergency shadow">Destino</span>}</div>;
}

function incidentTypeLabel(type: string): string {
  const labels: Record<string, string> = { TRAFFIC_ACCIDENT: 'Accidente de tránsito', CARDIAC: 'Emergencia cardiaca', UNCONSCIOUS: 'Persona inconsciente', FALL: 'Caída o lesión', TRAUMA: 'Trauma', RESPIRATORY: 'Emergencia respiratoria', OBSTETRIC: 'Emergencia obstétrica', OTHER: 'Otra emergencia' };
  return labels[type] ?? type;
}
