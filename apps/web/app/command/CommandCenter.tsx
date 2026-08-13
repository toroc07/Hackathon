'use client';

import {
  formatSeconds,
  MOCK_DISPATCH_RESPONSE,
  MOCK_EVENTS,
  type DispatchCandidate,
  type DispatchResponse,
  type Incident,
  type IncidentEvent,
  type OperationsSnapshot,
  type VehicleWithLocation,
  type Zone,
} from '@dispatch/contracts';
import { useEffect, useMemo, useState } from 'react';
import { AlertIcon, AmbulanceIcon, CheckIcon } from '@/src/components/ui/icons';
import { MapCanvas } from '@/src/components/map/MapCanvas';
import { useLiveIncidents } from '@/src/hooks/useLiveIncidents';
import { useLiveSnapshot } from '@/src/hooks/useLiveSnapshot';
import { useLiveVehicles } from '@/src/hooks/useLiveVehicles';
import {
  assignVehicle,
  CommandApiError,
  fetchDispatchCandidates,
  fetchIncidentEvents,
} from './data-access';

const priorityOrder = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
const incidentTypeLabel: Record<Incident['type'], string> = {
  TRAFFIC_ACCIDENT: 'Accidente vehicular',
  CARDIAC: 'Evento cardíaco',
  UNCONSCIOUS: 'Persona inconsciente',
  FALL: 'Caída',
  TRAUMA: 'Trauma',
  RESPIRATORY: 'Dificultad respiratoria',
  OBSTETRIC: 'Emergencia obstétrica',
  OTHER: 'Otra emergencia',
};

function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  return `hace ${Math.floor(minutes / 60)} h`;
}

function clockTime(timestamp: number): string {
  // Zona horaria FIJA: sin esto, el servidor (a menudo en UTC) y el navegador
  // (zona local del dispositivo) formatean la misma marca de tiempo con horas
  // distintas, y React aborta la hidratación por el texto que no coincide.
  return new Intl.DateTimeFormat('es-CO', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Bogota',
  }).format(timestamp);
}

function priorityStyle(priority: Incident['priority']): string {
  if (priority === 'P1') return 'border-emergency/50 bg-emergency-soft text-emergency';
  if (priority === 'P2') return 'border-warn/40 bg-warn-soft text-warn';
  if (priority === 'P3') return 'border-warn/30 bg-warn-soft text-warn';
  return 'border-edge-strong bg-surface-overlay text-content-secondary';
}

function statusColor(status: VehicleWithLocation['status']): string {
  if (status === 'AVAILABLE') return 'bg-ok';
  if (status === 'EN_ROUTE') return 'bg-info';
  if (status === 'OUT_OF_SERVICE') return 'bg-emergency';
  if (status === 'RESERVED' || status === 'ASSIGNED') return 'bg-warn';
  return 'bg-content-muted';
}

function Metric({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className={accent
      ? 'relative min-w-[190px] overflow-hidden rounded-lg border border-info/35 bg-info-soft px-4 py-3 shadow-[inset_3px_0_0_var(--info),0_10px_28px_rgba(11,21,38,.07)]'
      : 'min-w-[132px] border-l border-edge-subtle px-4 py-2'}>
      {accent && <span className="absolute right-2 top-1 text-3xl font-black text-info/10">×4→1</span>}
      <p className="relative text-[9px] font-bold uppercase tracking-[.16em] text-content-secondary">{label}</p>
      <p className={accent ? 'relative mt-1 text-3xl font-black tabular-nums text-info' : 'mt-1 text-xl font-bold tabular-nums text-content'}>{value}</p>
    </div>
  );
}

function IncidentQueue({
  incidents,
  selectedId,
  now,
  onSelect,
}: {
  incidents: Incident[];
  selectedId: string | null;
  now: number;
  onSelect: (id: string) => void;
}) {
  const sorted = useMemo(() => [...incidents]
    .filter((incident) => !['COMPLETED', 'CANCELLED', 'DUPLICATE'].includes(incident.status))
    .sort((a, b) => {
      const priorityDelta = priorityOrder[a.priority ?? 'P4'] - priorityOrder[b.priority ?? 'P4'];
      return priorityDelta || a.createdAt - b.createdAt;
    }), [incidents]);

  return (
    <aside className="flex min-h-0 w-[300px] shrink-0 flex-col border-r border-edge-subtle bg-surface-raised">
      <div className="flex items-center justify-between border-b border-edge-subtle px-4 py-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[.2em] text-content-muted">Cola operativa</p>
          <h2 className="mt-1 text-sm font-bold text-content">Incidentes abiertos</h2>
        </div>
        <span className="rounded-full bg-emergency-soft px-2.5 py-1 text-xs font-black text-emergency">{sorted.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sorted.map((incident) => (
          <button
            key={incident.id}
            type="button"
            onClick={() => onSelect(incident.id)}
            className={`group pressable w-full border-b border-edge-subtle px-4 py-4 text-left transition ${selectedId === incident.id ? 'bg-info-soft shadow-[inset_3px_0_0_var(--info)]' : 'hover:bg-content/[.035]'}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-sm font-black text-content">{incident.code}</span>
              <span className={`rounded border px-2 py-0.5 text-[10px] font-black ${priorityStyle(incident.priority)}`}>{incident.priority ?? '—'}</span>
            </div>
            <p className="mt-2 truncate text-xs font-semibold text-content-secondary">{incidentTypeLabel[incident.type]}</p>
            <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-content-muted">{incident.address ?? 'Ubicación sin dirección registrada'}</p>
            <div className="mt-3 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-content-muted">
              <span>{incident.status.replaceAll('_', ' ')}</span>
              <span className="tabular-nums text-content-secondary">{relativeTime(incident.createdAt, now)}</span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

const penaltyRows: Array<[keyof Pick<DispatchCandidate,
  'etaSeconds' | 'capabilityPenalty' | 'coveragePenalty' | 'workloadPenalty' | 'staleLocationPenalty' | 'operationalPenalty'>, string]> = [
  ['etaSeconds', 'ETA'],
  ['capabilityPenalty', 'Capacidad'],
  ['coveragePenalty', 'Cobertura'],
  ['workloadPenalty', 'Carga de turno'],
  ['staleLocationPenalty', 'Antigüedad GPS'],
  ['operationalPenalty', 'Operación / zona'],
];

function CandidateCard({ candidate, recommended }: { candidate: DispatchCandidate; recommended: boolean }) {
  return (
    <article className={`rounded-lg border p-3 ${recommended ? 'border-info/50 bg-info-soft shadow-[0_10px_28px_rgba(11,21,38,.08)]' : 'border-edge-subtle bg-content/[.025]'}`}>
      <div className="flex items-center gap-3">
        <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-black ${recommended ? 'bg-info text-surface' : 'bg-surface-overlay text-content-secondary'}`}>{candidate.rank}</span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-black text-content">{candidate.callsign}</p>
          <p className="text-[9px] font-semibold uppercase tracking-wider text-content-muted">{candidate.etaSource.replaceAll('_', ' ')} · {candidate.distanceM} m</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg font-black text-content">{formatSeconds(candidate.totalScore)}</p>
          <p className="text-[9px] font-bold uppercase tracking-wider text-content-muted">Score total</p>
        </div>
        {recommended && <span className="text-lg text-info" title="Recomendación del motor">★</span>}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-edge-subtle pt-2">
        {penaltyRows.map(([key, label]) => (
          <div key={key} className="flex items-center justify-between gap-2 text-[10px]">
            <dt className="text-content-muted">{label}</dt>
            <dd className={`font-mono font-bold tabular-nums ${key === 'etaSeconds' ? 'text-content-secondary' : candidate[key] > 0 ? 'text-warn' : 'text-content-muted'}`}>
              {key === 'etaSeconds' ? formatSeconds(candidate[key]) : `+${formatSeconds(candidate[key])}`}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 border-t border-edge-subtle pt-2 text-[10px] leading-4 text-content-secondary">{candidate.explanation}</p>
    </article>
  );
}

function ExcludedCandidate({ candidate }: { candidate: DispatchCandidate }) {
  return (
    <div className="rounded-md border border-edge-subtle bg-surface-raised/60 px-3 py-2 opacity-70">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-bold text-content-secondary">{candidate.callsign}</span>
        <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-content-muted">Excluida</span>
        <span className="ml-auto text-[9px] font-semibold text-content-muted">{candidate.excludedReason?.replaceAll('_', ' ')}</span>
      </div>
      <p className="mt-1 text-[10px] leading-4 text-content-muted">{candidate.explanation}</p>
    </div>
  );
}

function Timeline({ events, now }: { events: IncidentEvent[]; now: number }) {
  const sorted = useMemo(() => [...events].sort((a, b) => a.createdAt - b.createdAt), [events]);
  return (
    <ol className="space-y-0">
      {sorted.map((event, index) => (
        <li key={event.id} className="relative flex gap-3 pb-3 text-[10px] last:pb-0">
          {index < sorted.length - 1 && <span className="absolute left-[5px] top-3 h-full w-px bg-white/10" />}
          <span className={`relative mt-1 h-3 w-3 shrink-0 rounded-full border-2 border-surface-raised ${event.actorType === 'SYSTEM' ? 'bg-info' : 'bg-warn'}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="font-bold text-content-secondary">{event.eventType.replaceAll('_', ' ')}</p>
              <time className="shrink-0 font-mono text-content-muted" title={clockTime(event.createdAt)}>{relativeTime(event.createdAt, now)}</time>
            </div>
            <p className="mt-0.5 uppercase tracking-wider text-content-muted">{event.actorType}{event.actorId ? ` · ${event.actorId}` : ''}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

interface ConfirmationState { vehicleId: string; callsign: string; manual: boolean }

export function CommandCenter({ initialSnapshot, zones }: { initialSnapshot: OperationsSnapshot; zones: Zone[] }) {
  const snapshotLive = useLiveSnapshot(initialSnapshot);
  const incidentsLive = useLiveIncidents(initialSnapshot.incidents);
  const vehiclesLive = useLiveVehicles(initialSnapshot.vehicles);
  const snapshot = snapshotLive.data;
  const incidents = incidentsLive.data;
  const vehicles = vehiclesLive.data;
  const [selectedId, setSelectedId] = useState<string | null>(initialSnapshot.incidents[0]?.id ?? null);
  const [dispatch, setDispatch] = useState<DispatchResponse | null>(MOCK_DISPATCH_RESPONSE);
  const [events, setEvents] = useState<IncidentEvent[]>(MOCK_EVENTS);
  const [overrideVehicleId, setOverrideVehicleId] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const [actionState, setActionState] = useState<'idle' | 'sending'>('idle');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const selected = incidents.find((incident) => incident.id === selectedId) ?? incidents[0] ?? null;
  const recommended = dispatch?.candidates.find((candidate) => candidate.vehicleId === dispatch.recommendedVehicleId) ?? null;

  useEffect(() => {
    if (!selectedId && incidents[0]) setSelectedId(incidents[0].id);
  }, [incidents, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    if (selectedId !== MOCK_DISPATCH_RESPONSE.incidentId) {
      setDispatch(null);
      setEvents([]);
    }
    Promise.allSettled([fetchDispatchCandidates(selectedId), fetchIncidentEvents(selectedId)]).then(([candidatesResult, eventsResult]) => {
      if (!active) return;
      if (candidatesResult.status === 'fulfilled') setDispatch(candidatesResult.value);
      if (eventsResult.status === 'fulfilled') setEvents(eventsResult.value);
    });
    return () => { active = false; };
  }, [selectedId]);

  const openConfirmation = (vehicleId: string, manual: boolean) => {
    const vehicle = vehicles.find((item) => item.id === vehicleId);
    if (!vehicle) return;
    setConfirmation({ vehicleId, callsign: vehicle.callsign, manual });
    setNotice(null);
  };

  const confirmAssignment = async () => {
    if (!selected || !confirmation) return;
    setActionState('sending');
    try {
      const result = await assignVehicle(selected.id, confirmation.manual ? confirmation.vehicleId : undefined);
      setDispatch(result);
      setNotice({ tone: 'success', message: result.assignment
        ? `${confirmation.callsign} asignada. Confirmación registrada por el servidor.`
        : 'El servidor recalculó, pero no confirmó una asignación.' });
      setConfirmation(null);
      await Promise.all([snapshotLive.refresh(), incidentsLive.refresh(), vehiclesLive.refresh()]);
      const refreshedEvents = await fetchIncidentEvents(selected.id).catch(() => null);
      if (refreshedEvents) setEvents(refreshedEvents);
    } catch (caught) {
      const conflict = caught instanceof CommandApiError && caught.status === 409;
      setNotice({ tone: 'error', message: conflict
        ? `Conflicto: ${caught.message}. La pantalla se sincronizó con el servidor.`
        : caught instanceof Error ? caught.message : 'No fue posible confirmar la asignación.' });
      if (conflict) await Promise.all([snapshotLive.refresh(), incidentsLive.refresh(), vehiclesLive.refresh()]);
      setConfirmation(null);
    } finally {
      setActionState('idle');
    }
  };

  const transport = [snapshotLive.transport, incidentsLive.transport, vehiclesLive.transport].every((item) => item === 'sse') ? 'SSE EN VIVO' : 'SINCRONIZANDO';

  return (
    <main className="app-light flex h-screen min-h-[720px] flex-col overflow-hidden bg-surface text-content">
      <header className="flex h-[76px] shrink-0 items-center border-b border-edge-subtle bg-surface-raised px-4">
        <div className="mr-5 flex min-w-[280px] items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg border border-info/25 bg-info-soft text-lg font-black text-info">C</span>
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[.24em] text-info">Red prehospitalaria</p>
            <h1 className="text-sm font-black uppercase tracking-wide text-content">Command Center Cartagena</h1>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          <Metric label="Incidentes abiertos" value={snapshot.metrics.openIncidents} />
          <Metric label="Unidades disponibles" value={snapshot.metrics.availableUnits} />
          <Metric label="Asignación media" value={snapshot.metrics.avgAssignmentSeconds === null ? '—' : formatSeconds(snapshot.metrics.avgAssignmentSeconds)} />
          <Metric label="Respuesta media" value={snapshot.metrics.avgResponseSeconds === null ? '—' : formatSeconds(snapshot.metrics.avgResponseSeconds)} />
          <Metric label="Duplicados fusionados" value={snapshot.metrics.duplicateReportsMerged} accent />
          <Metric label="Despachadas" value={snapshot.metrics.dispatchedUnits} />
          <Metric label="Cobertura" value={snapshot.metrics.coverageHealth} />
        </div>
        <div className="ml-4 shrink-0 text-right">
          <p className="flex items-center justify-end gap-2 text-[9px] font-black tracking-wider text-ok">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
            </span>
            {transport}
          </p>
          <p className="mt-1 font-mono text-[10px] text-content-muted">{clockTime(snapshot.serverTime)}</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <IncidentQueue incidents={incidents} selectedId={selected?.id ?? null} now={snapshot.serverTime} onSelect={setSelectedId} />
        <section className="relative min-w-[420px] flex-1">
          <MapCanvas
            vehicles={vehicles}
            incidents={incidents}
            coverage={snapshot.coverage}
            zones={zones}
            selectedIncidentId={selected?.id ?? null}
            assignedVehicleId={dispatch?.assignment?.vehicleId ?? null}
            onSelectIncident={setSelectedId}
          />
          <div className="absolute bottom-4 right-4 w-64 rounded-lg border border-edge-subtle bg-surface/85 p-3 backdrop-blur">
            <div className="flex items-center justify-between">
              <p className="text-[9px] font-black uppercase tracking-[.16em] text-content-secondary">Salud por zona</p>
              <span className={`h-2.5 w-2.5 rounded-full ${snapshot.metrics.coverageHealth === 'HEALTHY' ? 'bg-ok' : snapshot.metrics.coverageHealth === 'CRITICAL' ? 'bg-emergency' : 'bg-warn'}`} />
            </div>
            <div className="mt-2 space-y-1">
              {snapshot.coverage.map((zone) => (
                <div key={zone.zoneId} className="flex items-center gap-2 text-[9px]">
                  <span className={`h-1.5 w-1.5 rounded-full ${zone.health === 'HEALTHY' ? 'bg-ok' : zone.health === 'CRITICAL' ? 'bg-emergency' : 'bg-warn'}`} />
                  <span className="min-w-0 flex-1 truncate text-content-secondary">{zone.zoneName}</span>
                  <span className="font-mono text-content-muted">{zone.availableUnits}/{zone.targetUnits}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <aside className="flex min-h-0 w-[450px] shrink-0 flex-col border-l border-edge-subtle bg-surface-raised">
          {selected ? (
            <>
              <div className="shrink-0 border-b border-edge-subtle px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={`rounded border px-2 py-0.5 text-[10px] font-black ${priorityStyle(selected.priority)}`}>{selected.priority ?? '—'}</span>
                  <h2 className="font-mono text-lg font-black text-content">{selected.code}</h2>
                  <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-content-muted">{selected.status}</span>
                </div>
                <p className="mt-1 text-xs font-semibold text-content-secondary">{incidentTypeLabel[selected.type]} · {selected.patientCount} paciente(s) · {selected.requiredCapability ?? 'Sin capacidad definida'}</p>
                <p className="mt-1 truncate text-[10px] text-content-muted">{selected.address}</p>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-[.18em] text-info">Decisión auditable</p>
                    <h3 className="mt-0.5 text-sm font-bold text-content">Candidatos del motor</h3>
                  </div>
                  {dispatch && <span className="font-mono text-[9px] text-content-muted">{dispatch.strategyVersion} · {dispatch.durationMs}ms</span>}
                </div>

                {dispatch ? (
                  <>
                    <div className="mt-3 space-y-2">
                      {dispatch.candidates.map((candidate) => <CandidateCard key={candidate.vehicleId} candidate={candidate} recommended={candidate.vehicleId === dispatch.recommendedVehicleId} />)}
                    </div>
                    <div className="my-4 flex items-center gap-3">
                      <span className="h-px flex-1 bg-white/10" />
                      <span className="text-[9px] font-black uppercase tracking-[.18em] text-content-muted">Excluidas · {dispatch.excluded.length}</span>
                      <span className="h-px flex-1 bg-white/10" />
                    </div>
                    <div className="space-y-1.5">
                      {dispatch.excluded.map((candidate) => <ExcludedCandidate key={candidate.vehicleId} candidate={candidate} />)}
                    </div>
                    {dispatch.recommendationRationale && (
                      <blockquote className="mt-4 rounded-lg border-l-2 border-info bg-info-soft px-3 py-3 text-[11px] font-medium leading-5 text-content">
                        <span className="mb-1 block text-[8px] font-black uppercase tracking-[.2em] text-info">Por qué esta unidad</span>
                        {dispatch.recommendationRationale}
                      </blockquote>
                    )}
                  </>
                ) : (
                  <div className="mt-4 flex flex-col items-center gap-2 rounded-lg border border-dashed border-edge-subtle p-6 text-center">
                    <span className="h-2 w-24 animate-pulse rounded-full bg-surface-overlay motion-reduce:animate-none" />
                    <p className="text-xs text-content-muted">Esperando cálculo persistido del motor.</p>
                  </div>
                )}

                <div className="mt-5 border-t border-edge-subtle pt-4">
                  <p className="mb-3 text-[9px] font-black uppercase tracking-[.18em] text-content-muted">Timeline del incidente</p>
                  <Timeline events={events} now={snapshot.serverTime} />
                </div>
              </div>

              <div className="shrink-0 border-t border-edge-subtle bg-surface-overlay p-4">
                {notice && (
                  <p
                    role="status"
                    className={`mb-3 flex items-start gap-2 rounded-md border px-3 py-2 text-[10px] leading-4 ${notice.tone === 'success' ? 'border-ok/30 bg-ok-soft text-ok' : 'border-emergency/30 bg-emergency-soft text-emergency'}`}
                  >
                    {notice.tone === 'success' ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
                    <span>{notice.message}</span>
                  </p>
                )}
                <button
                  type="button"
                  disabled={!recommended || actionState === 'sending'}
                  onClick={() => recommended && openConfirmation(recommended.vehicleId, false)}
                  className="pressable h-11 w-full rounded-md bg-info px-4 text-xs font-black uppercase tracking-[.12em] text-surface transition hover:bg-info/80 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {actionState === 'sending' ? 'Esperando servidor…' : `Asignar ${recommended?.callsign ?? 'recomendación'}`}
                </button>
                <div className="mt-2 flex gap-2">
                  <select
                    aria-label="Unidad para override manual"
                    value={overrideVehicleId}
                    onChange={(event) => setOverrideVehicleId(event.target.value)}
                    className="h-10 min-w-0 flex-1 rounded-md border border-edge-subtle bg-surface-overlay px-3 text-xs text-content-secondary outline-none focus:border-warn"
                  >
                    <option value="">Seleccionar unidad manual…</option>
                    {vehicles.map((vehicle) => (
                      <option key={vehicle.id} value={vehicle.id}>{vehicle.callsign} · {vehicle.capabilityLevel} · {vehicle.status}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!overrideVehicleId || actionState === 'sending'}
                    onClick={() => openConfirmation(overrideVehicleId, true)}
                    className="pressable h-10 rounded-md border border-warn/40 bg-warn-soft px-3 text-[10px] font-black uppercase tracking-wider text-warn transition hover:bg-warn/20 disabled:opacity-40"
                  >Override</button>
                </div>
                <p className="mt-2 text-center text-[9px] text-content-muted">El override siempre requiere confirmación y queda auditado.</p>
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center gap-3 text-content-muted">
              <AmbulanceIcon size={32} />
              <p className="text-sm">No hay incidentes abiertos</p>
            </div>
          )}
        </aside>
      </div>

      {confirmation && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-surface/80 p-6 backdrop-blur-sm modal-scrim-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
        >
          <div className="w-full max-w-md rounded-xl border border-edge-strong bg-surface-overlay p-5 shadow-2xl modal-panel-in">
            <p className="text-[9px] font-black uppercase tracking-[.2em] text-warn">{confirmation.manual ? 'Override manual' : 'Confirmar despacho'}</p>
            <h2 id="confirm-title" className="mt-2 text-xl font-black text-content">¿Asignar {confirmation.callsign} a {selected?.code}?</h2>
            <p className="mt-3 text-sm leading-6 text-content-secondary">{confirmation.manual
              ? 'Esta acción anula la recomendación del motor. El servidor registrará is_manual_override y el evento MANUAL_OVERRIDE.'
              : 'La unidad solo aparecerá asignada cuando el servidor confirme la operación.'}</p>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmation(null)} className="pressable h-10 rounded-md border border-edge-subtle px-4 text-xs font-bold text-content-secondary hover:bg-content/5">Cancelar</button>
              <button type="button" onClick={() => void confirmAssignment()} className="pressable h-10 rounded-md bg-warn px-4 text-xs font-black uppercase tracking-wider text-surface hover:bg-warn/80">Confirmar asignación</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
