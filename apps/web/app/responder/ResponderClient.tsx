'use client';

import {
  MOCK_FACILITIES,
  type ApiError, type Incident, type VehicleWithLocation,
} from '@dispatch/contracts';
import { useEffect, useRef, useState } from 'react';
import { AlertIcon, AmbulanceIcon, CheckIcon, LocationIcon, PhoneIcon } from '@/src/components/ui/icons';
import { Badge, Button } from '@/src/components/ui';
import { useLiveVehicles } from '@/src/hooks/useLiveVehicles';
import { useResponderVehicle } from '@/src/hooks/useResponderVehicle';
import { SlideToConfirm } from './SlideToConfirm';
import { useVehicleTracking, type GpsState } from './useVehicleTracking';
import { assignmentActionOutcome } from './responderState';

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
  const [lostAssignmentId, setLostAssignmentId] = useState<string | null>(null);
  const acceptedRef = useRef<Set<string>>(new Set());
  const context = serverContext?.assignment.id === lostAssignmentId ? null : serverContext;

  useEffect(() => { if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/responder/sw.js', { scope: '/responder/' }); }, []);
  useEffect(() => { if (serverContext && serverContext.assignment.id !== lostAssignmentId) setLostAssignmentId(null); }, [lostAssignmentId, serverContext]);
  // Vibra al llegar un reporte nuevo — la única señal de "algo pasó", sin
  // countdown ni pantalla de aceptar/rechazar por separado (§34: el panel
  // solo muestra el reporte, llamar, y notificar que va en camino).
  useEffect(() => {
    if (context?.assignment.status === 'OFFERED') navigator.vibrate?.([500, 180, 500, 180, 900]);
  }, [context?.assignment.id, context?.assignment.status]);

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

  /** Un solo botón: acepta la oferta si hace falta y marca en camino. El
   *  ciudadano lo ve reflejado en su seguimiento en vivo — esa pantalla ya
   *  dice "ayuda en camino", así que llamarlo YA es la notificación (§34:
   *  el panel no expone el flujo interno de aceptar/rechazar/trasladar). */
  const notifyEnRoute = async () => {
    if (!context || busy) return;
    if (context.assignment.status === 'OFFERED') {
      const accepted = await action('accept', {}, true);
      if (!accepted) return;
    }
    await updateVehicle('status', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'EN_ROUTE' }) });
  };
  const notified = Boolean(assignmentStatus && assignmentStatus !== 'OFFERED' && assignmentStatus !== 'ACCEPTED');

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

  return (
    <main className="app-light responder-shell">
      <ResponderHeader callsign={vehicle.callsign} gps={tracking.state} queued={tracking.queued} tone={context ? (notified ? 'green' : 'red') : 'green'} onChange={selected.change} />

      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.16em] text-content-muted">{context ? 'Reporte recibido' : 'Estado actual'}</p>
          <h1 className="text-2xl font-bold">{context ? incidentTypeLabel(context.incident.type) : 'Disponible'}</h1>
        </div>
        {context && <Badge className="bg-surface-overlay px-3 py-2 text-content-secondary">{context.incident.code}</Badge>}
      </div>

      <section className="state-card mt-4 overflow-hidden">
        <RouteMap vehicle={vehicle} incident={context?.incident ?? null} />
        <div className="p-4">
          {context ? (
            <>
              <p className="flex items-start gap-2 text-content-secondary"><LocationIcon className="mt-0.5 shrink-0 text-emergency" size={18} />{context.incident.address ?? 'Ubicación GPS del incidente'}</p>
              <p className="mt-2 text-sm font-semibold text-content-secondary">{context.incident.patientCount} paciente(s)</p>
              {/* El reporte que estructuró la IA (audio-intake.ts), tal cual — es lo único operativo que ve el responder. */}
              {live.data.reportSummary && (
                <p className="mt-3 rounded-xl bg-surface-overlay p-3 text-sm italic text-content-secondary">&ldquo;{live.data.reportSummary}&rdquo;</p>
              )}
            </>
          ) : (
            <p className="text-sm text-content-secondary">Te avisaremos apenas llegue un reporte para tu unidad.</p>
          )}
        </div>
      </section>

      {context && (
        <div className="mt-auto flex flex-col gap-3 pt-5">
          {live.data.reporterContact && (
            <a href={`tel:${live.data.reporterContact}`} className="pressable flex min-h-touch-lg items-center justify-center gap-2 rounded-xl border border-edge-strong font-semibold text-info">
              <PhoneIcon size={20} /> Llamar al ciudadano
            </a>
          )}
          {notified ? (
            <p className="flex items-center justify-center gap-2 rounded-xl bg-ok-soft py-3 font-semibold text-ok"><CheckIcon size={18} /> Ya avisamos que vas en camino</p>
          ) : (
            <Button className="responder-action bg-ok text-white" disabled={busy} onClick={() => void notifyEnRoute()}>Notificar: voy en camino</Button>
          )}
        </div>
      )}

      {!context && (
        <div className="mt-auto pt-5">
          <SlideToConfirm disabled={busy} label="Cerrar turno" large onConfirm={() => void updateVehicle('shift/end', { method: 'POST' })} />
        </div>
      )}
      {message && <p role="alert" className="responder-alert">{message}</p>}
    </main>
  );
}

function VehiclePicker({ vehicles, onSelect }: { vehicles: VehicleWithLocation[]; onSelect: (id: string) => void }) {
  const [registering, setRegistering] = useState(false);
  return (
    <main className="app-light responder-shell">
      <header className="safe-top"><p className="text-xs font-bold uppercase tracking-[.16em] text-ok">App ambulancia</p><h1 className="mt-2 text-3xl font-bold">Selecciona tu unidad</h1><p className="mt-2 text-content-secondary">Esta selección queda guardada en el dispositivo.</p></header>
      {registering ? (
        <RegisterVehicleForm onDone={(id) => onSelect(id)} onCancel={() => setRegistering(false)} />
      ) : (
        <>
          <div className="mt-6 grid gap-3">{vehicles.slice(0, 12).map((vehicle) => <button key={vehicle.id} type="button" onClick={() => onSelect(vehicle.id)} className="state-card pressable flex min-h-touch-lg items-center gap-4 p-4 text-left"><span className="grid h-12 w-12 place-items-center rounded-xl bg-ok-soft text-ok"><AmbulanceIcon size={28} /></span><span className="flex-1"><strong className="block text-lg">{vehicle.callsign}</strong><span className="text-sm text-content-muted">{vehicle.capabilityLevel} · {vehicle.status}</span></span></button>)}</div>
          <button type="button" onClick={() => setRegistering(true)} className="pressable mt-4 min-h-touch w-full rounded-xl border border-edge-strong font-semibold text-content-secondary">+ Registrar unidad nueva</button>
        </>
      )}
    </main>
  );
}

/** Alta simple de ambulancia: placa + número de unidad + hospital. */
function RegisterVehicleForm({ onDone, onCancel }: { onDone: (vehicleId: string) => void; onCancel: () => void }) {
  const [plate, setPlate] = useState('');
  const [callsign, setCallsign] = useState('');
  const [hospitalFacilityId, setHospitalFacilityId] = useState(MOCK_FACILITIES.find((f) => f.type === 'HOSPITAL')?.id ?? 'f-bocagrande');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/vehicles/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plate, callsign, hospitalFacilityId, capabilityLevel: 'BLS' }),
      });
      const payload = await response.json() as { vehicleId?: string; error?: { message?: string } };
      if (!response.ok || !payload.vehicleId) throw new Error(payload.error?.message ?? 'No se pudo registrar la unidad');
      onDone(payload.vehicleId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo registrar la unidad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-6 flex flex-col gap-4">
      <label className="block text-sm font-semibold text-content-secondary">Placa
        <input required value={plate} onChange={(e) => setPlate(e.target.value)} className="mt-2 w-full rounded-xl border border-edge-strong bg-surface-base px-4 py-3 text-[16px] text-content" placeholder="ABC123" />
      </label>
      <label className="block text-sm font-semibold text-content-secondary">Número de unidad
        <input required value={callsign} onChange={(e) => setCallsign(e.target.value)} className="mt-2 w-full rounded-xl border border-edge-strong bg-surface-base px-4 py-3 text-[16px] text-content" placeholder="A31" />
      </label>
      <label className="block text-sm font-semibold text-content-secondary">Hospital
        <select value={hospitalFacilityId} onChange={(e) => setHospitalFacilityId(e.target.value)} className="mt-2 w-full rounded-xl border border-edge-strong bg-surface-base px-4 py-3 text-content">
          {MOCK_FACILITIES.filter((f) => f.type !== 'BASE').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="flex items-start gap-2 text-emergency text-sm"><AlertIcon size={18} /> <span>{error}</span></p>}
      <Button type="submit" disabled={busy} aria-busy={busy} className="min-h-touch-lg w-full text-[17px]">{busy ? 'Registrando…' : 'Registrar y continuar'}</Button>
      <button type="button" onClick={onCancel} className="min-h-touch text-sm font-semibold text-content-secondary">Cancelar</button>
    </form>
  );
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
