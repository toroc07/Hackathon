'use client';

import {
  CARTAGENA_BBOX,
  CARTAGENA_CENTER,
  type CreateIncidentRequest,
  type CreateIncidentResponse,
  type IncidentDetailResponse,
  type IncidentType,
} from '@dispatch/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveIncidents } from '@/src/hooks/useLiveIncidents';

const TYPES: ReadonlyArray<{ type: IncidentType; icon: string; label: string }> = [
  { type: 'TRAFFIC_ACCIDENT', icon: '🚗', label: 'Choque' },
  { type: 'CARDIAC', icon: '♥', label: 'Dolor de pecho' },
  { type: 'UNCONSCIOUS', icon: '◉', label: 'Inconsciente' },
  { type: 'FALL', icon: '↘', label: 'Caída' },
  { type: 'TRAUMA', icon: '✚', label: 'Herida o golpe' },
  { type: 'RESPIRATORY', icon: '≈', label: 'No puede respirar bien' },
  { type: 'OBSTETRIC', icon: '●', label: 'Embarazo' },
  { type: 'OTHER', icon: '!', label: 'Otra emergencia' },
];

const SIGNALS = [
  ['unconscious', 'No responde'],
  ['notBreathing', 'No respira'],
  ['severeBleeding', 'Sangrado fuerte'],
  ['trapped', 'Está atrapado'],
] as const;

type Signals = NonNullable<CreateIncidentRequest['signals']>;
type LocationState =
  | { kind: 'locating' }
  | { kind: 'ready'; lat: number; lng: number; accuracyM: number }
  | { kind: 'manual' };

function withinCartagena(lat: number, lng: number) {
  return lat >= CARTAGENA_BBOX.minLat && lat <= CARTAGENA_BBOX.maxLat
    && lng >= CARTAGENA_BBOX.minLng && lng <= CARTAGENA_BBOX.maxLng;
}

function newIdempotencyKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `report-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function ReportPage() {
  const [location, setLocation] = useState<LocationState>({ kind: 'locating' });
  const [type, setType] = useState<IncidentType | null>(null);
  const [signals, setSignals] = useState<Signals>({});
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateIncidentResponse | null>(null);
  const [detail, setDetail] = useState<IncidentDetailResponse | null>(null);
  const requestKey = useRef(newIdempotencyKey());
  const live = useLiveIncidents();

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocation({ kind: 'manual' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (!withinCartagena(coords.latitude, coords.longitude)) {
          setLocation({ kind: 'manual' });
          return;
        }
        setLocation({
          kind: 'ready', lat: coords.latitude, lng: coords.longitude,
          accuracyM: Math.max(0, Math.round(coords.accuracy)),
        });
      },
      () => setLocation({ kind: 'manual' }),
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 },
    );
  }, []);

  const liveIncident = useMemo(
    () => live.data.find((incident) => incident.id === result?.incident.id) ?? result?.incident,
    [live.data, result],
  );

  useEffect(() => {
    if (!result) return;
    let active = true;
    void fetch(`/api/incidents/${result.incident.id}`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<IncidentDetailResponse> : null)
      .then((value) => { if (active && value) setDetail(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [result, liveIncident?.status]);

  function markMap(event: React.PointerEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
    setLocation({
      kind: 'ready',
      lat: CARTAGENA_BBOX.maxLat - y * (CARTAGENA_BBOX.maxLat - CARTAGENA_BBOX.minLat),
      lng: CARTAGENA_BBOX.minLng + x * (CARTAGENA_BBOX.maxLng - CARTAGENA_BBOX.minLng),
      accuracyM: 35,
    });
  }

  function toggleSignal(key: keyof Signals) {
    setSignals((current) => ({ ...current, [key]: !current[key] }));
  }

  async function sendReport() {
    if (!type || location.kind !== 'ready') return;
    setSending(true);
    setError(null);
    const body: CreateIncidentRequest = {
      type,
      point: { lat: location.lat, lng: location.lng },
      accuracyM: location.accuracyM,
      patientCount: 1,
      signals,
      source: 'WEB',
      ...(description.trim() ? { description: description.trim() } : {}),
    };
    const attempt = () => fetch('/api/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey.current },
      body: JSON.stringify(body),
    });
    try {
      let response: Response;
      try {
        response = await attempt();
      } catch {
        response = await attempt();
      }
      const payload = await response.json() as CreateIncidentResponse | { error?: { message?: string } };
      if (!response.ok || !('incident' in payload)) {
        throw new Error('error' in payload ? payload.error?.message : 'No pudimos recibir el reporte');
      }
      setResult(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos recibir el reporte. Intenta de nuevo.');
    } finally {
      setSending(false);
    }
  }

  if (result) {
    const status = liveIncident?.status ?? result.incident.status;
    const eta = detail?.liveEtaSeconds;
    return (
      <main className="min-h-screen bg-[#edf2ee] px-5 py-8 text-dispatch-ink">
        <section className="mx-auto max-w-lg overflow-hidden rounded-[2rem] bg-white shadow-xl shadow-slate-900/10">
          <div className="bg-dispatch-green px-7 py-8 text-white">
            <p className="text-sm font-bold uppercase tracking-[0.18em]">Reporte recibido</p>
            <h1 className="mt-3 text-5xl font-black tracking-tight" aria-label={`Código ${result.incident.code}`}>{result.incident.code}</h1>
            <p className="mt-3 text-lg text-emerald-50">Guarda este código para consultar la emergencia.</p>
          </div>
          <div className="space-y-6 px-7 py-8" aria-live="polite">
            {result.wasMerged && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-lg font-bold text-emerald-950">
                Ya hay una unidad en camino a esta emergencia.
              </div>
            )}
            <div>
              <p className="text-sm font-bold uppercase tracking-wider text-slate-500">Estado en vivo</p>
              <p className="mt-2 text-2xl font-black">{status.replaceAll('_', ' ')}</p>
              <p className="mt-1 text-sm text-slate-500">Actualización: {live.transport === 'sse' ? 'en vivo' : 'conexión limitada'}</p>
            </div>
            {detail?.assignment && (
              <div className="rounded-2xl bg-slate-950 p-5 text-white">
                <p className="text-sm font-bold uppercase tracking-wider text-slate-300">Unidad asignada</p>
                <p className="mt-2 text-2xl font-black">{detail.assignedVehicle?.callsign ?? 'Ambulancia confirmada'}</p>
                {eta != null && <p className="mt-1 text-lg text-emerald-300">Llegada estimada: {Math.max(1, Math.ceil(eta / 60))} min</p>}
              </div>
            )}
            <p className="border-t border-slate-200 pt-5 text-sm leading-6 text-slate-600">
              Si la situación cambia, llama al <strong>123</strong>. No muevas a una persona herida salvo que exista un peligro inmediato.
            </p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#edf2ee] px-4 py-5 text-dispatch-ink sm:px-6 sm:py-8">
      <section className="mx-auto max-w-2xl">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.18em] text-dispatch-red">Emergencias Cartagena</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">¿Qué está pasando?</h1>
          </div>
          <div className={`rounded-full px-3 py-2 text-xs font-bold ${location.kind === 'ready' ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-950'}`}>
            {location.kind === 'locating' ? 'Ubicando…' : location.kind === 'ready' ? 'Ubicación lista' : 'Marca el lugar'}
          </div>
        </header>

        {location.kind === 'manual' && (
          <div className="mb-6 rounded-3xl border border-slate-300 bg-white p-4 shadow-sm">
            <p className="mb-3 font-bold">Toca el mapa donde ocurre la emergencia</p>
            <button
              type="button"
              onPointerDown={markMap}
              aria-label="Mapa local de Cartagena. Toca para marcar la emergencia"
              className="relative h-48 w-full overflow-hidden rounded-2xl border-2 border-slate-300 bg-[#dce8e5] text-left"
              style={{ backgroundImage: 'linear-gradient(32deg, transparent 47%, #ffffff 48%, #ffffff 52%, transparent 53%), linear-gradient(118deg, transparent 47%, #ffffff 48%, #ffffff 52%, transparent 53%)', backgroundSize: '80px 80px' }}
            >
              <span className="absolute left-4 top-4 rounded-full bg-white/95 px-3 py-1 text-xs font-black shadow">Cartagena</span>
              <span className="absolute bottom-4 right-4 rounded-full bg-dispatch-red px-3 py-2 text-sm font-bold text-white">Marcar aquí</span>
            </button>
            <button type="button" className="mt-3 text-sm font-bold text-dispatch-green underline" onClick={() => setLocation({ kind: 'ready', ...CARTAGENA_CENTER, accuracyM: 100 })}>
              Usar el centro de Cartagena como referencia
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="group" aria-label="Tipo de emergencia">
          {TYPES.map((item) => {
            const selected = type === item.type;
            return (
              <button
                key={item.type}
                type="button"
                aria-pressed={selected}
                onClick={() => setType(item.type)}
                className={`min-h-32 rounded-3xl border-2 p-4 text-left transition active:scale-[0.98] ${selected ? 'border-dispatch-red bg-red-50 ring-4 ring-red-100' : 'border-white bg-white shadow-sm hover:border-slate-300'}`}
              >
                <span className="block text-4xl font-black text-dispatch-red" aria-hidden="true">{item.icon}</span>
                <span className="mt-3 block text-base font-black leading-tight">{item.label}</span>
              </button>
            );
          })}
        </div>

        <section className="mt-6 rounded-3xl bg-white p-5 shadow-sm">
          <h2 className="text-lg font-black">¿Hay alguna señal crítica?</h2>
          <p className="mt-1 text-sm text-slate-600">Marca solo lo que puedes observar.</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {SIGNALS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={signals[key] === true}
                onClick={() => toggleSignal(key)}
                className={`min-h-14 rounded-2xl border-2 px-3 text-sm font-black ${signals[key] ? 'border-dispatch-red bg-dispatch-red text-white' : 'border-slate-200 bg-slate-50 text-slate-900'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <details className="mt-5 border-t border-slate-200 pt-4">
            <summary className="cursor-pointer text-sm font-bold text-slate-700">Agregar descripción (opcional)</summary>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value.slice(0, 1000))}
              className="mt-3 min-h-24 w-full rounded-xl border border-slate-300 p-3 text-base focus:border-dispatch-green focus:outline-none focus:ring-2 focus:ring-emerald-100"
              placeholder="Ej.: choque de dos carros frente a…"
            />
          </details>
        </section>

        {error && <p className="mt-4 rounded-2xl bg-red-100 p-4 font-bold text-red-900" role="alert">{error}</p>}
        <button
          type="button"
          onClick={() => void sendReport()}
          disabled={!type || location.kind !== 'ready' || sending}
          className="mt-5 min-h-16 w-full rounded-2xl bg-dispatch-red px-6 text-xl font-black text-white shadow-lg shadow-red-900/20 transition active:scale-[0.99] disabled:bg-slate-400 disabled:shadow-none"
        >
          {sending ? 'Enviando reporte…' : location.kind === 'locating' ? 'Esperando ubicación…' : 'Enviar emergencia'}
        </button>
        <p className="mt-3 text-center text-xs leading-5 text-slate-500">No necesitas iniciar sesión. La prioridad se calcula con las señales que marcas.</p>
      </section>
    </main>
  );
}
