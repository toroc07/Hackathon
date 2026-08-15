'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import type { Point } from '@dispatch/contracts';
import type { GeoJSONSource, Map as MapLibreMap, Marker } from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cumulativeDistances, distanceMeters, pointAtDistance, progressAt,
  straightLineRoute, type RouteResult,
} from '@/src/lib/routing';

/**
 * Mapa en vivo con la ruta REAL por calles.
 *
 * La geometría sale del grafo vial de OpenStreetMap de Cartagena
 * (backend/routing) vía /api/routing; el fondo son teselas de OSM. Sustituye a
 * los mapas esquemáticos anteriores: en una emergencia la persona necesita
 * reconocer su calle, y una línea recta sobre una retícula inventada no dice
 * si la ambulancia ya cruzó la bahía o sigue del otro lado.
 *
 * El icono se desliza por la ruta entre lecturas de GPS y el tramo ya recorrido
 * se atenúa — el mismo lenguaje visual de Uber/inDriver, que la gente ya sabe
 * leer sin que nadie se lo explique.
 *
 * maplibre-gl se carga con `import()` dinámico: son ~800 KB que no deben
 * bloquear el primer pintado de una pantalla que alguien abre en pánico y con
 * datos móviles.
 */

/** Teselas de OpenStreetMap. CARTO las sirve desde datos de OSM sin API key y
 *  con un estilo claro y legible; la atribución cita a ambos, como exige la
 *  licencia. Cambiable por entorno sin tocar el código. */
const TILE_URL = process.env.NEXT_PUBLIC_MAP_TILES_URL
  ?? 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
const TILE_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>';

/** Cuánto debe desviarse el vehículo de la ruta vigente para recalcularla. Por
 *  debajo de esto solo se desliza el icono: pedir un A* nuevo en cada lectura
 *  de GPS haría parpadear el trazo sin aportar nada. */
const RECALC_METERS = 120;

/** Suavizado del icono por frame. 0.08 ≈ 1 s para cubrir el hueco entre dos
 *  lecturas; más alto se ve a saltos, más bajo se retrasa de la realidad. */
const EASE = 0.08;

/** Patrón de guiones desplazándose hacia el destino. Se precalcula porque
 *  cambiar `line-dasharray` regenera una textura: a 60 fps sería caro, a ~14
 *  fps el movimiento ya se lee igual de fluido. */
const DASH_SEQUENCE: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1],
  [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5],
  [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];
const DASH_FRAME_MS = 70;

export interface LiveRouteMapProps {
  /** Posición actual del vehículo. `null` mientras no hay unidad asignada. */
  vehicle: Point | null;
  /** Destino: el lugar del incidente. */
  destination: Point;
  vehicleLabel?: string;
  destinationLabel?: string;
  height?: number;
  /** Notifica la ruta vigente para que el contenedor muestre la distancia y el
   *  ETA del grafo en vez de recalcular su propia estimación. */
  onRoute?: (route: RouteResult) => void;
  className?: string;
}

interface ActiveRoute {
  coordinates: [number, number][];
  totals: number[];
  result: RouteResult;
}

export function LiveRouteMap({
  vehicle, destination, vehicleLabel = 'Ambulancia',
  destinationLabel = 'Emergencia', height = 320, onRoute, className,
}: LiveRouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const vehicleMarkerRef = useRef<Marker | null>(null);
  const destinationMarkerRef = useRef<Marker | null>(null);

  const routeRef = useRef<ActiveRoute | null>(null);
  const targetProgressRef = useRef(0);
  const shownProgressRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  /** El encuadre automático deja de pelearse con el usuario en cuanto este
   *  mueve el mapa a mano. */
  const userMovedRef = useRef(false);
  const fittedRef = useRef(false);
  /** En una ref y no en las dependencias: si el contenedor pasa una función
   *  en línea, meterla en el array dispararía una petición de ruta por render. */
  const onRouteRef = useRef(onRoute);
  onRouteRef.current = onRoute;

  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<RouteResult | null>(null);
  /** Contador de reintentos del respaldo. Sin esto, una sola petición fallida
   *  (servicio despertando, red intermitente) dejaba la línea recta fija para
   *  siempre: el vehículo siempre está "sobre" su propia recta, así que el
   *  guardia de recálculo nunca volvía a pedir la ruta del grafo. */
  const [retry, setRetry] = useState(0);
  const retryUsedRef = useRef(0);
  /** Cambia con cada ruta nueva. El bucle lo compara para forzar un primer
   *  dibujo: con ruta recién llegada el vehículo está en el metro 0 y no se
   *  mueve, así que sin esto la guarda de reposo se comería el trazo entero. */
  const routeVersionRef = useRef(0);

  // Las dependencias van por valor y no por objeto: `{lat, lng}` es nuevo en
  // cada render del padre y volvería a montar el mapa una y otra vez.
  const vehicleLat = vehicle?.lat ?? null;
  const vehicleLng = vehicle?.lng ?? null;
  const { lat: destinationLat, lng: destinationLng } = destination;

  // ── Crear el mapa ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // maplibre-gl v6 no tiene default export: solo nombrados.
      const { Map, NavigationControl } = await import('maplibre-gl');
      if (cancelled || !containerRef.current) return;

      const map = new Map({
        container: containerRef.current,
        style: {
          version: 8,
          sources: {
            osm: { type: 'raster', tiles: [TILE_URL], tileSize: 256, attribution: TILE_ATTRIBUTION },
          },
          layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
        },
        center: [destinationLng, destinationLat],
        zoom: 13,
        attributionControl: { compact: true },
        // Girar o inclinar el mapa solo estorba a quien lo mira con una mano
        // mientras habla por teléfono.
        pitchWithRotate: false,
        dragRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right');

      const markUserMoved = () => { userMovedRef.current = true; };
      map.on('dragstart', markUserMoved);
      map.on('wheel', markUserMoved);

      map.on('load', () => {
        if (cancelled) return;
        map.addSource('route', { type: 'geojson', data: emptyLine() });
        map.addSource('route-done', { type: 'geojson', data: emptyLine() });

        // Tramo recorrido: visible pero apagado, para que se lea "esto ya lo
        // hizo" de un vistazo.
        map.addLayer({
          id: 'route-done', type: 'line', source: 'route-done',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#8fa0b8', 'line-width': 6, 'line-opacity': 0.55 },
        });
        // Contorno blanco: sin él la ruta se pierde sobre las calles claras.
        map.addLayer({
          id: 'route-casing', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': 11, 'line-opacity': 0.9 },
        });
        map.addLayer({
          id: 'route-line', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#0b63d6', 'line-width': 6 },
        });
        // Guiones que avanzan hacia el destino: dan sentido de movimiento
        // aunque el GPS tarde en actualizar.
        map.addLayer({
          id: 'route-flow', type: 'line', source: 'route',
          layout: { 'line-cap': 'butt', 'line-join': 'round' },
          paint: {
            'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.75,
            'line-dasharray': DASH_SEQUENCE[0],
          },
        });

        setReady(true);
      });

      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      vehicleMarkerRef.current?.remove();
      vehicleMarkerRef.current = null;
      destinationMarkerRef.current?.remove();
      destinationMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Solo al montar: el destino posterior se aplica moviendo la cámara, no
    // recreando el mapa — recrearlo perdería el zoom que el usuario eligió.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pedir la ruta al grafo ───────────────────────────────────────────────
  const fetchRoute = useCallback(async (from: Point, to: Point): Promise<RouteResult> => {
    try {
      const params = new URLSearchParams({
        fromLat: String(from.lat), fromLng: String(from.lng),
        toLat: String(to.lat), toLng: String(to.lng),
      });
      const response = await fetch(`/api/routing?${params}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('routing');
      return (await response.json()) as RouteResult;
    } catch {
      // /api/routing ya degrada a línea recta por su cuenta; esto solo cubre
      // que se caiga la propia app (sin conexión).
      return straightLineRoute(from, to);
    }
  }, []);

  useEffect(() => {
    if (vehicleLat === null || vehicleLng === null) {
      routeRef.current = null;
      setRoute(null);
      return;
    }

    const from = { lat: vehicleLat, lng: vehicleLng };
    const to = { lat: destinationLat, lng: destinationLng };
    const current = routeRef.current;
    const forced = retry !== retryUsedRef.current;

    // Recalcular solo si el vehículo se salió de la ruta o cambió el destino.
    if (current && !forced) {
      const end = current.coordinates[current.coordinates.length - 1];
      const sameDestination = distanceMeters(to, { lat: end[1], lng: end[0] }) < 30;
      const progress = progressAt(current.coordinates, current.totals, from);
      const onRouteNow =
        distanceMeters(from, pointAtDistance(current.coordinates, current.totals, progress))
        < RECALC_METERS;

      if (sameDestination && onRouteNow) {
        targetProgressRef.current = progress;
        return;
      }
    }

    let cancelled = false;
    retryUsedRef.current = retry;
    void fetchRoute(from, to).then((result) => {
      if (cancelled) return;
      const totals = cumulativeDistances(result.coordinates);
      routeRef.current = { coordinates: result.coordinates, totals, result };
      targetProgressRef.current = 0;
      shownProgressRef.current = 0;
      fittedRef.current = false;
      routeVersionRef.current += 1;
      setRoute(result);
      onRouteRef.current?.(result);
    });

    return () => { cancelled = true; };
  }, [vehicleLat, vehicleLng, destinationLat, destinationLng, fetchRoute, retry]);

  // Mientras la ruta sea el respaldo recto, se vuelve a intentar: el servicio
  // suele estar solo despertando, y a los pocos segundos ya devuelve calles.
  useEffect(() => {
    if (route?.source !== 'straight') return;
    const timer = window.setTimeout(() => setRetry((count) => count + 1), 12_000);
    return () => window.clearTimeout(timer);
  }, [route, retry]);

  // ── Marcador de destino ──────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    let cancelled = false;
    void (async () => {
      const { Marker: MarkerClass } = await import('maplibre-gl');
      if (cancelled || !mapRef.current) return;

      if (destinationMarkerRef.current) {
        destinationMarkerRef.current.setLngLat([destinationLng, destinationLat]);
      } else {
        destinationMarkerRef.current = new MarkerClass({
          element: destinationElement(destinationLabel), anchor: 'bottom',
        }).setLngLat([destinationLng, destinationLat]).addTo(map);
      }
    })();

    return () => { cancelled = true; };
  }, [ready, destinationLat, destinationLng, destinationLabel]);

  // ── Animación ────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    let cancelled = false;

    void (async () => {
      const { Marker: MarkerClass } = await import('maplibre-gl');
      if (cancelled || !mapRef.current) return;

      // Quien activa reduced-motion suele hacerlo por mareo o migraña, y aquí
      // ya está bajo estrés: se actualiza igual, pero sin interpolar ni animar.
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      let lastDashAt = 0;
      let dashIndex = 0;
      let drawnProgress = Number.NaN;
      let drawnVersion = -1;
      let lastDrawAt = 0;

      const frame = (now: number) => {
        const active = routeRef.current;

        if (active) {
          const delta = targetProgressRef.current - shownProgressRef.current;
          // Ambulancia detenida (o ya alcanzada la posición real): no hay nada
          // que recalcular. Sin esta salida, el bucle seguiría proyectando y
          // reposicionando 60 veces por segundo sobre un punto que no cambia,
          // gastando batería del teléfono que alguien necesita encendido.
          const fresh = drawnVersion !== routeVersionRef.current;
          const idle = !fresh && Math.abs(delta) < 0.5 && vehicleMarkerRef.current !== null;

          if (!idle) {
            shownProgressRef.current += reduceMotion ? delta : delta * EASE;
          }
          const shown = shownProgressRef.current;
          const here = pointAtDistance(active.coordinates, active.totals, shown);

          // El marcador se mueve en cada frame activo: es un `transform` de CSS.
          if (vehicleMarkerRef.current) {
            if (!idle) vehicleMarkerRef.current.setLngLat([here.lng, here.lat]);
          } else {
            vehicleMarkerRef.current = new MarkerClass({
              element: vehicleElement(vehicleLabel), anchor: 'center',
            }).setLngLat([here.lng, here.lat]).addTo(map);
          }

          // Redibujar la polilínea NO es barato: cada `setData` reconstruye los
          // teselados de una geometría de cientos de puntos. A 60 fps eso deja
          // el teléfono sin hilo principal. Con recortar el trazo unas 10 veces
          // por segundo, y solo si el vehículo avanzó de verdad, se ve igual.
          const moved = Number.isNaN(drawnProgress) || Math.abs(shown - drawnProgress) > 2;
          if ((fresh || moved) && !idle && now - lastDrawAt > 100) {
            lastDrawAt = now;
            drawnProgress = shown;
            drawnVersion = routeVersionRef.current;
            const remaining = sliceFrom(active, shown, here);
            (map.getSource('route') as GeoJSONSource | undefined)?.setData(lineOf(remaining));
            (map.getSource('route-done') as GeoJSONSource | undefined)
              ?.setData(lineOf(sliceTo(active, shown, here)));

            if (!fittedRef.current && !userMovedRef.current && remaining.length > 1) {
              fittedRef.current = true;
              fitTo(map, remaining);
            }
          }

          if (!reduceMotion && now - lastDashAt > DASH_FRAME_MS) {
            lastDashAt = now;
            dashIndex = (dashIndex + 1) % DASH_SEQUENCE.length;
            map.setPaintProperty('route-flow', 'line-dasharray', DASH_SEQUENCE[dashIndex]);
          }
        }

        frameRef.current = requestAnimationFrame(frame);
      };

      frameRef.current = requestAnimationFrame(frame);
    })();

    return () => {
      cancelled = true;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [ready, vehicleLabel]);

  // Sin vehículo se retira el icono y el mapa se centra en el incidente: dejar
  // una ambulancia parada en el último punto conocido sería mentir.
  useEffect(() => {
    if (vehicleLat !== null || !ready) return;
    const map = mapRef.current;
    if (!map) return;

    vehicleMarkerRef.current?.remove();
    vehicleMarkerRef.current = null;
    (map.getSource('route') as GeoJSONSource | undefined)?.setData(emptyLine());
    (map.getSource('route-done') as GeoJSONSource | undefined)?.setData(emptyLine());
    if (!userMovedRef.current) {
      map.easeTo({ center: [destinationLng, destinationLat], zoom: 14 });
    }
  }, [vehicleLat, ready, destinationLat, destinationLng]);

  const recenter = () => {
    userMovedRef.current = false;
    const map = mapRef.current;
    const active = routeRef.current;
    if (!map) return;
    if (active) {
      const here = pointAtDistance(active.coordinates, active.totals, shownProgressRef.current);
      fitTo(map, sliceFrom(active, shownProgressRef.current, here));
    } else {
      map.easeTo({ center: [destinationLng, destinationLat], zoom: 14 });
    }
  };

  return (
    <div className={`relative overflow-hidden ${className ?? ''}`} style={{ height }}>
      {/* El mapa es apoyo visual; el estado real lo dan el titular, el ETA y la
          línea de tiempo, que sí son texto accesible. */}
      <div ref={containerRef} aria-hidden className="h-full w-full bg-[#e8eef5]" />

      {!ready && (
        <div className="absolute inset-0 grid place-items-center bg-[#e8eef5]" role="status">
          <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-white border-t-[#0b63d6]" />
          <span className="sr-only">Cargando el mapa</span>
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-1.5">
        <span className="rounded-full bg-white/95 px-3 py-1 text-[11px] font-bold text-[#33415c] shadow-sm">
          {route?.source === 'graph' ? 'Ruta por calles · OpenStreetMap' : 'Trayecto estimado'}
        </span>
        {route && (
          <span className="rounded-full bg-[#0b63d6] px-3 py-1 text-[11px] font-bold text-white shadow-sm">
            {(route.distanceMeters / 1000).toFixed(1)} km · {route.durationText}
          </span>
        )}
        {route?.source === 'straight' && (
          <span className="rounded-full bg-white/95 px-3 py-1 text-[11px] font-semibold text-[#a4530a] shadow-sm">
            Sin servicio de rutas: distancia aproximada
          </span>
        )}
      </div>

      {/* Abajo a la izquierda: MapLibre reserva la esquina inferior derecha
          para la atribución, que al expandirse taparía el botón. */}
      <button
        type="button" onClick={recenter}
        className="map-control absolute bottom-3 left-3 rounded-full bg-white/95 px-3 py-2 text-[11px] font-bold text-[#33415c] shadow-md"
      >
        Centrar
      </button>
    </div>
  );
}

// ============================================================
// GEOMETRÍA PARA LAS CAPAS
// ============================================================

type Line = GeoJSON.Feature<GeoJSON.LineString>;

const emptyLine = (): Line => lineOf([]);

function lineOf(coordinates: [number, number][]): Line {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } };
}

function fitTo(map: MapLibreMap, coordinates: [number, number][]): void {
  if (coordinates.length < 2) return;
  let [minLng, minLat] = coordinates[0];
  let [maxLng, maxLat] = coordinates[0];
  for (const [lng, lat] of coordinates) {
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
    // Margen extra arriba: ahí van las etiquetas flotantes de distancia y ETA.
    padding: { top: 74, bottom: 46, left: 40, right: 40 },
    maxZoom: 16, duration: 700,
  });
}

/** Tramo que queda por delante, empezando exactamente donde está el icono. */
function sliceFrom(
  route: ActiveRoute, meters: number, head: { lng: number; lat: number },
): [number, number][] {
  const rest: [number, number][] = [[head.lng, head.lat]];
  for (let i = 0; i < route.coordinates.length; i += 1) {
    if (route.totals[i] > meters) rest.push(route.coordinates[i]);
  }
  return rest.length > 1 ? rest : route.coordinates.slice(-2);
}

/** Tramo ya recorrido, terminando donde está el icono. */
function sliceTo(
  route: ActiveRoute, meters: number, head: { lng: number; lat: number },
): [number, number][] {
  const done: [number, number][] = [];
  for (let i = 0; i < route.coordinates.length; i += 1) {
    if (route.totals[i] <= meters) done.push(route.coordinates[i]);
  }
  done.push([head.lng, head.lat]);
  return done.length > 1 ? done : [];
}

// ============================================================
// MARCADORES
// ============================================================

/** SVG en línea, no emoji: el emoji depende de la fuente del sistema y se ve
 *  distinto (o no se ve) según el teléfono. */
function vehicleElement(label: string): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('aria-label', label);
  element.style.cssText = 'position:relative;width:46px;height:46px;display:grid;place-items:center;';
  element.innerHTML = `
    <span style="position:absolute;inset:0;border-radius:50%;background:rgba(217,4,41,.20);
                 animation:dispatch-pulse 1.8s ease-out infinite"></span>
    <span style="position:relative;width:32px;height:32px;border-radius:50%;background:#d90429;
                 box-shadow:0 3px 10px rgba(0,0,0,.32);display:grid;place-items:center">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff"
           stroke-width="2.6" stroke-linecap="round">
        <path d="M12 7v10M7 12h10"/>
      </svg>
    </span>`;
  return element;
}

function destinationElement(label: string): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('aria-label', label);
  element.style.cssText = 'width:30px;height:38px;';
  element.innerHTML = `
    <svg width="30" height="38" viewBox="0 0 30 38" fill="none">
      <path d="M15 37C15 37 28 23.5 28 14.5C28 7.04 22.18 1 15 1S2 7.04 2 14.5C2 23.5 15 37 15 37Z"
            fill="#0b63d6" stroke="#fff" stroke-width="2.2"/>
      <circle cx="15" cy="14.5" r="5" fill="#fff"/>
    </svg>`;
  return element;
}
