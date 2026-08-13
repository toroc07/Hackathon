'use client';

import type {
  Incident,
  VehicleStatus,
  VehicleWithLocation,
  Zone,
  ZoneCoverage,
} from '@dispatch/contracts';
import { useEffect, useRef, useState, type MouseEvent } from 'react';

const CARTAGENA_BOUNDS = { minLng: -75.59, maxLng: -75.46, minLat: 10.38, maxLat: 10.51 };
const INTERPOLATION_MS = 3_000;

type Coordinate = [number, number];
type FeatureCollection = { type: 'FeatureCollection'; features: Array<Record<string, unknown>> };
type GeoJsonSource = { setData(data: FeatureCollection): void };
type MapInstance = {
  on(event: string, callback: () => void): void;
  on(event: string, layerId: string, callback: (event: { features?: Array<{ properties?: Record<string, unknown> }> }) => void): void;
  addSource(id: string, source: Record<string, unknown>): void;
  addLayer(layer: Record<string, unknown>): void;
  getSource(id: string): GeoJsonSource | undefined;
  remove(): void;
};
type MarkerInstance = { setLngLat(point: Coordinate): MarkerInstance; addTo(map: MapInstance): MarkerInstance; remove(): void };
type MapLibreRuntime = {
  Map: new (options: Record<string, unknown>) => MapInstance;
  Marker: new (options: Record<string, unknown>) => MarkerInstance;
  addProtocol(name: string, handler: unknown): void;
};
type PmtilesRuntime = {
  Protocol: new () => { tile: unknown; add(archive: unknown): void };
  PMTiles: new (url: string) => unknown;
};

declare global {
  interface Window {
    maplibregl?: MapLibreRuntime;
    pmtiles?: PmtilesRuntime;
  }
}

interface PositionState {
  from: Coordinate;
  to: Coordinate;
  startedAt: number;
  vehicle: VehicleWithLocation;
}

const statusColor: Record<VehicleStatus, string> = {
  AVAILABLE: '#2dd4bf',
  RESERVED: '#fbbf24',
  ASSIGNED: '#fb923c',
  EN_ROUTE: '#60a5fa',
  ON_SCENE: '#c084fc',
  TRANSPORTING: '#f472b6',
  UNAVAILABLE: '#94a3b8',
  OUT_OF_SERVICE: '#ef4444',
  OFFLINE: '#475569',
};

function emptyCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function fleetGeoJson(positions: Map<string, PositionState>, now: number): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [...positions.values()].map((state) => {
      const progress = Math.min(1, Math.max(0, (now - state.startedAt) / INTERPOLATION_MS));
      const lng = state.from[0] + (state.to[0] - state.from[0]) * progress;
      const lat = state.from[1] + (state.to[1] - state.from[1]) * progress;
      return {
        type: 'Feature',
        id: state.vehicle.id,
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: {
          id: state.vehicle.id,
          callsign: state.vehicle.callsign,
          status: state.vehicle.status,
          heading: state.vehicle.location?.heading ?? 0,
        },
      };
    }),
  };
}

function incidentGeoJson(incidents: Incident[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: incidents.map((incident) => ({
      type: 'Feature',
      id: incident.id,
      geometry: { type: 'Point', coordinates: [incident.lng, incident.lat] },
      properties: { id: incident.id, priority: incident.priority ?? 'P4', code: incident.code },
    })),
  };
}

function coverageGeoJson(zones: Zone[], coverage: ZoneCoverage[]): FeatureCollection {
  const byId = new Map(coverage.map((zone) => [zone.zoneId, zone]));
  return {
    type: 'FeatureCollection',
    features: zones.map((zone) => {
      const points = zone.polygon.map(([lat, lng]) => [lng, lat]);
      return {
        type: 'Feature',
        id: zone.id,
        geometry: { type: 'Polygon', coordinates: [[...points, points[0]]] },
        properties: {
          zoneId: zone.id,
          health: byId.get(zone.id)?.health ?? 'HEALTHY',
          deficit: byId.get(zone.id)?.deficit ?? 0,
        },
      };
    }),
  };
}

function assignmentGeoJson(
  incidents: Incident[],
  selectedIncidentId: string | null,
  assignedVehicleId: string | null,
  positions: Map<string, PositionState>,
): FeatureCollection {
  const incident = incidents.find((item) => item.id === selectedIncidentId);
  const vehicle = assignedVehicleId ? positions.get(assignedVehicleId) : null;
  if (!incident || !vehicle) return emptyCollection();
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [vehicle.to, [incident.lng, incident.lat]] },
      properties: {},
    }],
  };
}

function loadLocalScript(src: string, globalReady: () => boolean): Promise<void> {
  if (globalReady()) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing) return new Promise((resolve, reject) => {
    existing.addEventListener('load', () => resolve(), { once: true });
    existing.addEventListener('error', () => reject(new Error(src)), { once: true });
  });
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(src));
    document.head.appendChild(script);
  });
}

function drawFallback(
  canvas: HTMLCanvasElement,
  fleet: FeatureCollection,
  incidents: Incident[],
  zones: Zone[],
  coverage: ZoneCoverage[],
  selectedIncidentId: string | null,
  assignedVehicleId: string | null,
) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const point = ([lng, lat]: Coordinate): Coordinate => [
    ((lng - CARTAGENA_BOUNDS.minLng) / (CARTAGENA_BOUNDS.maxLng - CARTAGENA_BOUNDS.minLng)) * width,
    height - ((lat - CARTAGENA_BOUNDS.minLat) / (CARTAGENA_BOUNDS.maxLat - CARTAGENA_BOUNDS.minLat)) * height,
  ];

  ctx.fillStyle = '#071019';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#132837';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 52) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y < height; y += 52) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }

  const healthById = new Map(coverage.map((item) => [item.zoneId, item.health]));
  zones.forEach((zone) => {
    const health = healthById.get(zone.id);
    ctx.beginPath();
    zone.polygon.forEach(([lat, lng], index) => {
      const [x, y] = point([lng, lat]);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = health === 'CRITICAL' ? '#ef44442e' : health === 'DEGRADED' ? '#f59e0b22' : '#14b8a612';
    ctx.strokeStyle = health === 'CRITICAL' ? '#ef4444' : health === 'DEGRADED' ? '#f59e0b' : '#14b8a6';
    ctx.fill();
    ctx.stroke();
  });

  const selected = incidents.find((incident) => incident.id === selectedIncidentId);
  const assigned = fleet.features.find((feature) => feature.id === assignedVehicleId);
  if (selected && assigned) {
    const geometry = assigned.geometry as { coordinates: Coordinate };
    const [fromX, fromY] = point(geometry.coordinates);
    const [toX, toY] = point([selected.lng, selected.lat]);
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(toX, toY); ctx.stroke(); ctx.setLineDash([]);
  }

  fleet.features.forEach((feature) => {
    const geometry = feature.geometry as { coordinates: Coordinate };
    const properties = feature.properties as { callsign: string; status: VehicleStatus };
    const [x, y] = point(geometry.coordinates);
    ctx.fillStyle = statusColor[properties.status];
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.font = '600 10px ui-monospace'; ctx.fillStyle = '#dbeafe'; ctx.fillText(properties.callsign, x + 9, y + 3);
  });
  incidents.forEach((incident) => {
    const [x, y] = point([incident.lng, incident.lat]);
    const radius = incident.priority === 'P1' ? 12 : incident.priority === 'P2' ? 10 : 8;
    ctx.fillStyle = incident.id === selectedIncidentId ? '#ffffff' : '#fb7185';
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
}

export interface MapCanvasProps {
  vehicles: VehicleWithLocation[];
  incidents: Incident[];
  coverage: ZoneCoverage[];
  zones: Zone[];
  selectedIncidentId: string | null;
  assignedVehicleId: string | null;
  onSelectIncident: (incidentId: string) => void;
}

export function MapCanvas(props: MapCanvasProps) {
  const { vehicles, incidents, coverage, zones, selectedIncidentId, assignedVehicleId } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const markerRef = useRef<MarkerInstance | null>(null);
  const positionsRef = useRef(new Map<string, PositionState>());
  const latestRef = useRef(props);
  const [mode, setMode] = useState<'loading' | 'maplibre' | 'fallback'>('loading');

  useEffect(() => { latestRef.current = props; }, [props]);

  useEffect(() => {
    const now = performance.now();
    const next = new Map<string, PositionState>();
    vehicles.forEach((vehicle) => {
      if (!vehicle.location) return;
      const target: Coordinate = [vehicle.location.lng, vehicle.location.lat];
      const previous = positionsRef.current.get(vehicle.id);
      next.set(vehicle.id, { from: previous?.to ?? target, to: target, startedAt: now, vehicle });
    });
    positionsRef.current = next;
  }, [vehicles]);

  useEffect(() => {
    let disposed = false;
    async function initialize() {
      try {
        await Promise.all([
          loadLocalScript('/vendor/maplibre-gl.js', () => Boolean(window.maplibregl)),
          loadLocalScript('/vendor/pmtiles.js', () => Boolean(window.pmtiles)),
        ]);
        if (disposed || !containerRef.current || !window.maplibregl || !window.pmtiles) return;
        const protocol = new window.pmtiles.Protocol();
        protocol.add(new window.pmtiles.PMTiles(`${location.origin}/maps/cartagena.pmtiles`));
        window.maplibregl.addProtocol('pmtiles', protocol.tile);
        const map = new window.maplibregl.Map({
          container: containerRef.current,
          center: [-75.53, 10.425],
          zoom: 12.3,
          attributionControl: false,
          style: {
            version: 8,
            sources: { cartagena: { type: 'vector', url: `pmtiles://${location.origin}/maps/cartagena.pmtiles` } },
            layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#071019' } }],
          },
        });
        mapRef.current = map;
        map.on('load', () => {
          const current = latestRef.current;
          map.addSource('coverage', { type: 'geojson', data: coverageGeoJson(current.zones, current.coverage) });
          map.addLayer({ id: 'coverage-fill', type: 'fill', source: 'coverage', paint: {
            'fill-color': ['match', ['get', 'health'], 'CRITICAL', '#ef4444', 'DEGRADED', '#f59e0b', '#14b8a6'],
            'fill-opacity': ['match', ['get', 'health'], 'CRITICAL', 0.25, 'DEGRADED', 0.16, 0.08],
          } });
          map.addSource('assignment', { type: 'geojson', data: emptyCollection() });
          map.addLayer({ id: 'assignment-line', type: 'line', source: 'assignment', paint: { 'line-color': '#38bdf8', 'line-width': 3, 'line-dasharray': [2, 2] } });
          map.addSource('incidents', { type: 'geojson', data: incidentGeoJson(current.incidents) });
          map.addLayer({ id: 'incident-points', type: 'circle', source: 'incidents', paint: {
            'circle-color': '#fb7185',
            'circle-radius': ['match', ['get', 'priority'], 'P1', 12, 'P2', 10, 'P3', 8, 6],
            'circle-stroke-color': '#7f1d1d', 'circle-stroke-width': 2,
          } });
          map.on('click', 'incident-points', (event) => {
            const incidentId = event.features?.[0]?.properties?.id;
            if (typeof incidentId === 'string') latestRef.current.onSelectIncident(incidentId);
          });
          map.addSource('fleet', { type: 'geojson', data: emptyCollection() });
          map.addLayer({ id: 'fleet-symbols', type: 'symbol', source: 'fleet', layout: {
            'text-field': ['concat', '●  ', ['get', 'callsign']], 'text-size': 12, 'text-font': ['Open Sans Bold'],
            'text-allow-overlap': true, 'text-anchor': 'left', 'text-offset': [0.3, 0],
          }, paint: {
            'text-color': ['match', ['get', 'status'], 'AVAILABLE', '#2dd4bf', 'EN_ROUTE', '#60a5fa', 'OUT_OF_SERVICE', '#ef4444', '#94a3b8'],
            'text-halo-color': '#071019', 'text-halo-width': 2,
          } });
          setMode('maplibre');
        });
      } catch {
        if (!disposed) setMode('fallback');
      }
    }
    void initialize();
    const timeout = window.setTimeout(() => setMode((current) => current === 'loading' ? 'fallback' : current), 1_200);
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      markerRef.current?.remove();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.maplibregl) return;
    markerRef.current?.remove();
    const selected = incidents.find((incident) => incident.id === selectedIncidentId);
    if (!selected) return;
    const element = document.createElement('button');
    element.className = 'h-6 w-6 rounded-full border-4 border-white bg-red-500 shadow-[0_0_0_7px_rgba(239,68,68,.25)]';
    element.setAttribute('aria-label', `Incidente seleccionado ${selected.code}`);
    markerRef.current = new window.maplibregl.Marker({ element })
      .setLngLat([selected.lng, selected.lat])
      .addTo(map);
    return () => markerRef.current?.remove();
  }, [incidents, selectedIncidentId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('incidents')) return;
    map.getSource('incidents')?.setData(incidentGeoJson(incidents));
    map.getSource('coverage')?.setData(coverageGeoJson(zones, coverage));
    map.getSource('assignment')?.setData(assignmentGeoJson(
      incidents,
      selectedIncidentId,
      assignedVehicleId,
      positionsRef.current,
    ));
  }, [incidents, coverage, zones, selectedIncidentId, assignedVehicleId, vehicles]);

  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      const current = latestRef.current;
      const fleet = fleetGeoJson(positionsRef.current, now);
      const map = mapRef.current;
      map?.getSource('fleet')?.setData(fleet);
      if (!map && canvasRef.current) drawFallback(
        canvasRef.current,
        fleet,
        current.incidents,
        current.zones,
        current.coverage,
        current.selectedIncidentId,
        current.assignedVehicleId,
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const selectFallbackIncident = (event: MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    let nearest: { id: string; distance: number } | null = null;
    incidents.forEach((incident) => {
      const x = ((incident.lng - CARTAGENA_BOUNDS.minLng) / (CARTAGENA_BOUNDS.maxLng - CARTAGENA_BOUNDS.minLng)) * rect.width;
      const y = rect.height - ((incident.lat - CARTAGENA_BOUNDS.minLat) / (CARTAGENA_BOUNDS.maxLat - CARTAGENA_BOUNDS.minLat)) * rect.height;
      const distance = Math.hypot(x - clickX, y - clickY);
      if (distance <= 20 && (!nearest || distance < nearest.distance)) nearest = { id: incident.id, distance };
    });
    const target = nearest as { id: string; distance: number } | null;
    if (target) props.onSelectIncident(target.id);
  };

  return (
    <div className="relative h-full min-h-[520px] overflow-hidden bg-[#071019]" aria-label="Mapa operativo de Cartagena">
      <div ref={containerRef} className="absolute inset-0" />
      {mode !== 'maplibre' && <canvas ref={canvasRef} onClick={selectFallbackIncident} className="absolute inset-0 h-full w-full cursor-crosshair" />}
      <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 backdrop-blur">
        <p className="text-[10px] font-bold uppercase tracking-[.2em] text-cyan-300">Cartagena · malla operativa</p>
        <p className="mt-1 text-xs text-slate-300">{vehicles.length} unidades · {incidents.length} incidente(s)</p>
      </div>
      <div className="pointer-events-none absolute bottom-4 left-4 flex flex-wrap gap-3 rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-300 backdrop-blur">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-teal-400" /> Disponible</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-400" /> En ruta</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-rose-400" /> Incidente</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-sm border border-amber-400 bg-amber-500/20" /> Déficit</span>
      </div>
      {mode === 'fallback' && (
        <div className="absolute right-4 top-4 rounded-md border border-amber-400/30 bg-amber-950/80 px-2 py-1 text-[10px] font-semibold text-amber-200">
          Vista local de contingencia
        </div>
      )}
    </div>
  );
}
