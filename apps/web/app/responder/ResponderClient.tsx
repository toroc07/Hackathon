'use client';

import {
  MOCK_FACILITIES,
  REJECT_REASON,
  type ApiError,
  type AssignmentStatus,
  type RejectReason,
  type VehicleWithLocation,
} from '@dispatch/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button } from '@/src/components/ui';
import { useLiveVehicles } from '@/src/hooks/useLiveVehicles';
import { useResponderVehicle } from '@/src/hooks/useResponderVehicle';
import { SlideToConfirm } from './SlideToConfirm';
import { useVehicleTracking, type GpsState } from './useVehicleTracking';
import { assignmentActionOutcome } from './responderState';

const REASON_LABELS: Record<RejectReason, string> = {
  MECHANICAL: 'Falla mecánica',
  CREW_UNAVAILABLE: 'Tripulación no disponible',
  ALREADY_COMMITTED: 'Ya comprometida',
  UNSAFE_ACCESS: 'Acceso inseguro',
  OTHER: 'Otro motivo',
};

const GPS_LABELS: Record<GpsState, string> = {
  waiting: 'GPS buscando señal',
  sending: 'GPS transmitiendo',
  offline: 'SIN ENVÍO GPS',
  denied: 'GPS SIN PERMISO',
  unsupported: 'GPS NO DISPONIBLE',
};

function useSelectedVehicle(vehicles: VehicleWithLocation[]) {
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  useEffect(() => {
    const queryId = new URLSearchParams(window.location.search).get('vehicleId');
    const saved = localStorage.getItem('dispatch:responder-vehicle');
    const selected = [queryId, saved, vehicles[0]?.id].find((id) => id && vehicles.some((vehicle) => vehicle.id === id));
    if (selected) setVehicleId(selected);
  }, [vehicles]);
  const select = (id: string) => {
    localStorage.setItem('dispatch:responder-vehicle', id);
    setVehicleId(id);
  };
  return { vehicleId, select };
}

export function ResponderClient() {
  const liveVehicles = useLiveVehicles();
  const { vehicleId, select } = useSelectedVehicle(liveVehicles.data);
  const live = useResponderVehicle(vehicleId);
  const vehicle = live.data.vehicle;
  const serverContext = live.data.activeAssignment;
  const tracking = useVehicleTracking(vehicleId, Boolean(vehicle?.activeShiftId));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<RejectReason>('OTHER');
  const [destinationId, setDestinationId] = useState(MOCK_FACILITIES.find((facility) => facility.type === 'HOSPITAL')?.id ?? 'f-bocagrande');
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [lostAssignmentId, setLostAssignmentId] = useState<string | null>(null);
  const acceptedRef = useRef<Set<string>>(new Set());
  const context = serverContext?.assignment.id === lostAssignmentId ? null : serverContext;

  useEffect(() => {
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/responder/sw.js', { scope: '/responder/' });
  }, []);

  useEffect(() => {
    if (serverContext && serverContext.assignment.id !== lostAssignmentId) setLostAssignmentId(null);
  }, [lostAssignmentId, serverContext]);

  const offer = context?.assignment.status === 'OFFERED' ? context.assignment : null;
  const offerId = offer?.id;
  const offerExpiresAt = offer?.expiresAt;
  useEffect(() => {
    if (!offerId || offerExpiresAt == null) return;
    navigator.vibrate?.([500, 200, 500, 200, 900]);
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((offerExpiresAt - Date.now()) / 1_000)));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [offerExpiresAt, offerId]);

  useEffect(() => {
    if (offerId && secondsLeft === 0) void live.refresh();
  }, [live.refresh, offerId, secondsLeft]);

  const assignmentStatus = context?.assignment.status;
  const action = async (path: string, body?: unknown, idempotent = false) => {
    if (!context || busy) return false;
    const assignmentId = context.assignment.id;
    if (idempotent && acceptedRef.current.has(assignmentId)) return false;
    if (idempotent) acceptedRef.current.add(assignmentId);
    setBusy(true);
    setMessage(null);
    const idemKey = `responder-${assignmentId}-${path}`;
    try {
      const response = await fetch(`/api/assignments/${encodeURIComponent(assignmentId)}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': idemKey },
        body: JSON.stringify(body ?? {}),
      });
      const outcome = assignmentActionOutcome(response.status);
      if (outcome.kind === 'conflict') {
        setLostAssignmentId(assignmentId);
        setMessage(outcome.message);
        await live.refresh();
        return false;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as ApiError | null;
        throw new Error(payload?.error.message ?? `Error HTTP ${response.status}`);
      }
      await live.refresh();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible completar la acción');
      return false;
    } finally {
      if (idempotent) acceptedRef.current.delete(assignmentId);
      setBusy(false);
    }
  };

  const statusLabel = useMemo(() => {
    if (lostAssignmentId) return 'DISPONIBLE';
    const labels: Partial<Record<AssignmentStatus, string>> = {
      OFFERED: 'OFERTA ENTRANTE', ACCEPTED: 'ASIGNACIÓN ACEPTADA', EN_ROUTE: 'EN RUTA',
      ON_SCENE: 'EN EL SITIO', TRANSPORTING: 'TRASLADANDO', COMPLETED: 'SERVICIO CERRADO',
    };
    return assignmentStatus ? labels[assignmentStatus] ?? assignmentStatus : vehicle?.status ?? 'CARGANDO';
  }, [assignmentStatus, lostAssignmentId, vehicle?.status]);

  if (!vehicleId || !vehicle) {
    return <main className="responder-shell items-center justify-center"><p className="text-2xl font-black">Cargando unidad…</p></main>;
  }

  if (liveVehicles.data.length > 1 && !localStorage.getItem('dispatch:responder-vehicle')) {
    return (
      <main className="responder-shell">
        <h1 className="text-3xl font-black">SELECCIONA TU UNIDAD</h1>
        <div className="mt-6 grid gap-3">
          {liveVehicles.data.slice(0, 8).map((item) => (
            <Button className="min-h-16 text-xl" key={item.id} onClick={() => select(item.id)}>{item.callsign}</Button>
          ))}
        </div>
      </main>
    );
  }

  const gpsDanger = tracking.state !== 'sending';
  const header = (
    <header className="flex items-center justify-between gap-3 border-b border-slate-700 pb-4">
      <div><p className="text-xs font-black tracking-[0.22em] text-cyan-300">UNIDAD</p><h1 className="text-4xl font-black">{vehicle.callsign}</h1></div>
      <Badge className={`px-4 py-3 text-sm ${gpsDanger ? 'bg-red-600 text-white' : 'bg-emerald-400 text-slate-950'}`}>
        {GPS_LABELS[tracking.state]}{tracking.queued ? ` · ${tracking.queued} EN COLA` : ''}
      </Badge>
    </header>
  );

  if (!vehicle.activeShiftId || vehicle.status === 'OFFLINE') {
    return (
      <main className="responder-shell">
        {header}
        <section className="flex flex-1 flex-col justify-center"><p className="text-lg text-slate-300">Turno cerrado</p><h2 className="mt-2 text-5xl font-black">FUERA DE SERVICIO</h2></section>
        <Button className="responder-primary bg-emerald-400 text-slate-950" disabled={busy} onClick={async () => {
          setBusy(true);
          setMessage(null);
          try {
            const response = await fetch(`/api/vehicles/${vehicle.id}/shift/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ crewUserIds: [] }) });
            if (!response.ok) throw new Error('No se pudo iniciar el turno');
            await live.refresh();
          } catch (error) { setMessage(error instanceof Error ? error.message : 'Error'); } finally { setBusy(false); }
        }}>INICIAR TURNO</Button>
        {message && <p role="alert" className="responder-alert">{message}</p>}
      </main>
    );
  }

  if (offer && context) {
    return (
      <main className="responder-shell responder-offer" aria-live="assertive">
        <div className="flex items-center justify-between"><span className="text-xl font-black">OFERTA URGENTE</span><span className="rounded-full bg-white px-5 py-3 text-4xl font-black text-red-700">{secondsLeft}s</span></div>
        <section className="flex flex-1 flex-col justify-center">
          <p className="text-2xl font-bold">{context.incident.code} · {context.incident.priority ?? 'SIN PRIORIDAD'}</p>
          <h2 className="mt-4 text-5xl font-black leading-tight">{context.incident.address ?? 'Ubicación del incidente'}</h2>
          <p className="mt-5 text-2xl">{context.incident.patientCount} paciente(s) · {context.incident.type}</p>
          <label className="mt-8 text-sm font-black uppercase tracking-wider">Motivo si rechazas
            <select className="mt-2 min-h-16 w-full rounded-xl bg-white px-4 text-lg font-bold text-slate-950" value={rejectReason} onChange={(event) => setRejectReason(event.target.value as RejectReason)}>
              {REJECT_REASON.map((reason) => <option key={reason} value={reason}>{REASON_LABELS[reason]}</option>)}
            </select>
          </label>
          <div className="mt-3"><SlideToConfirm disabled={busy} label={`RECHAZAR · ${REASON_LABELS[rejectReason]}`} onConfirm={() => void action('reject', { reason: rejectReason })} /></div>
        </section>
        <Button className="responder-primary bg-white text-2xl text-red-800" disabled={busy || secondsLeft === 0} onClick={() => void action('accept', {}, true)}>ACEPTAR E IR</Button>
        {message && <p role="alert" className="responder-alert bg-white text-red-900">{message}</p>}
      </main>
    );
  }

  return (
    <main className="responder-shell">
      {header}
      <section className="flex flex-1 flex-col justify-center">
        <p className="text-lg font-bold text-cyan-300">{statusLabel}</p>
        {context ? (
          <><h2 className="mt-3 text-5xl font-black leading-tight">{context.incident.address ?? context.incident.code}</h2><p className="mt-5 text-xl text-slate-300">{context.incident.code} · {context.incident.patientCount} paciente(s)</p></>
        ) : (
          <><h2 className="mt-3 text-5xl font-black">DISPONIBLE</h2><p className="mt-5 text-xl text-slate-300">Esperando una asignación del centro de despacho.</p></>
        )}
      </section>

      {assignmentStatus === 'EN_ROUTE' && <Button className="responder-primary bg-amber-300 text-slate-950" disabled={busy} onClick={() => void action('arrive')}>LLEGUÉ AL SITIO</Button>}
      {assignmentStatus === 'ON_SCENE' && <div className="space-y-3"><label className="block text-sm font-black uppercase tracking-wider">Destino
        <select className="mt-2 min-h-16 w-full rounded-xl bg-white px-4 text-lg font-bold text-slate-950" value={destinationId} onChange={(event) => setDestinationId(event.target.value)}>
          {MOCK_FACILITIES.filter((facility) => facility.type !== 'BASE').map((facility) => <option key={facility.id} value={facility.id}>{facility.name}</option>)}
        </select></label><Button className="responder-primary bg-cyan-300 text-slate-950" disabled={busy} onClick={() => void action('transport', { destinationFacilityId: destinationId })}>INICIAR TRASLADO</Button></div>}
      {assignmentStatus === 'TRANSPORTING' && <SlideToConfirm disabled={busy} label="CERRAR SERVICIO" large onConfirm={() => void action('complete')} />}
      {assignmentStatus === 'ACCEPTED' && <Button className="responder-primary bg-emerald-300 text-slate-950" disabled={busy} onClick={async () => {
        setBusy(true);
        setMessage(null);
        try {
          const response = await fetch(`/api/vehicles/${vehicle.id}/status`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'EN_ROUTE' }) });
          if (!response.ok) throw new Error('No se pudo iniciar la ruta');
          await live.refresh();
        } catch (error) { setMessage(error instanceof Error ? error.message : 'Error'); } finally { setBusy(false); }
      }}>INICIAR RUTA</Button>}
      {!context && <SlideToConfirm disabled={busy} label="CERRAR TURNO" large onConfirm={async () => {
        setBusy(true);
        try {
          const response = await fetch(`/api/vehicles/${vehicle.id}/shift/end`, { method: 'POST' });
          if (!response.ok) throw new Error('No se pudo cerrar el turno');
          await live.refresh();
        } catch (error) { setMessage(error instanceof Error ? error.message : 'Error'); } finally { setBusy(false); }
      }} />}
      {message && <p role="alert" className="responder-alert">{message}</p>}
    </main>
  );
}
