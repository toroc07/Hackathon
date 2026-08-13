'use client';

import type { TrackingResponse } from '@dispatch/contracts';
import { useEffect, useRef } from 'react';

/**
 * Mapa de seguimiento para el ciudadano.
 *
 * Canvas 2D en vez de MapLibre a proposito: solo hay que mostrar DOS puntos y
 * la linea entre ellos. Cargar un motor de mapas completo para eso costaria
 * ~800 KB en una red movil, justo cuando la persona esta esperando una
 * ambulancia. Menos dependencias tambien significa menos formas de fallar en
 * vivo.
 *
 * La ambulancia se INTERPOLA entre respuestas del servidor: sin eso saltaria
 * cada 4 segundos y pareceria rota. Es el mismo truco que usa Uber.
 */

interface Props {
  tracking: TrackingResponse;
}

interface Point { lat: number; lng: number }

/** Proyeccion equirectangular local. A escala de ciudad la distorsion es
 *  despreciable y evita traer una libreria de proyecciones. */
function project(p: Point, center: Point, scale: number, size: { w: number; h: number }) {
  const cos = Math.cos((center.lat * Math.PI) / 180);
  return {
    x: size.w / 2 + (p.lng - center.lng) * cos * scale,
    y: size.h / 2 - (p.lat - center.lat) * scale,
  };
}

export function TrackingMap({ tracking }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  // Posicion mostrada vs. objetivo: la primera persigue a la segunda.
  const shownRef = useRef<Point | null>(null);
  const targetRef = useRef<Point | null>(null);

  useEffect(() => {
    if (tracking.vehicle) {
      const next = { lat: tracking.vehicle.lat, lng: tracking.vehicle.lng };
      targetRef.current = next;
      // Primer dato: aparece donde esta, sin animar desde el centro del mapa.
      if (!shownRef.current) shownRef.current = next;
    } else {
      targetRef.current = null;
      shownRef.current = null;
    }
  }, [tracking.vehicle]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const incident = { lat: tracking.incidentLat, lng: tracking.incidentLng };

    // Respeta la preferencia del sistema: con reduced-motion no interpolamos ni
    // pulsamos, solo redibujamos cuando llegan datos nuevos. Quien activa esa
    // opción suele hacerlo por mareo o migraña, y aquí ya está bajo estrés.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // Los colores salen de los tokens de globals.css, no hardcodeados: si el
    // tema cambia, el mapa cambia con él.
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;
    const COLOR = {
      bg: token('--surface-base', '#070b14'),
      grid: token('--border-subtle', 'rgba(174,187,212,0.14)'),
      vehicle: token('--emergency', '#ff4557'),
      target: token('--info', '#4cc4ff'),
    };

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== Math.round(rect.width * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const size = { w: rect.width, h: rect.height };

      // Perseguir el objetivo suavemente (~12% por frame ≈ 0.5s para cubrir).
      const target = targetRef.current;
      if (target && shownRef.current) {
        const factor = reduceMotion ? 1 : 0.12;
        shownRef.current = {
          lat: shownRef.current.lat + (target.lat - shownRef.current.lat) * factor,
          lng: shownRef.current.lng + (target.lng - shownRef.current.lng) * factor,
        };
      }
      const vehicle = shownRef.current;

      // Encuadre: ambos puntos visibles con margen. Si no hay vehiculo aun,
      // se centra en el incidente con un zoom fijo.
      const center = vehicle
        ? { lat: (incident.lat + vehicle.lat) / 2, lng: (incident.lng + vehicle.lng) / 2 }
        : incident;

      let scale = 90_000;
      if (vehicle) {
        const spanLat = Math.abs(incident.lat - vehicle.lat) || 0.001;
        const spanLng = Math.abs(incident.lng - vehicle.lng) || 0.001;
        const cos = Math.cos((center.lat * Math.PI) / 180);
        scale = Math.min(
          (size.h * 0.62) / spanLat,
          (size.w * 0.62) / (spanLng * cos),
        );
        scale = Math.min(scale, 160_000);
      }

      ctx.clearRect(0, 0, size.w, size.h);

      // Fondo con retícula: da sensación de mapa y de movimiento cuando el
      // encuadre se ajusta, sin necesitar tiles.
      ctx.fillStyle = COLOR.bg;
      ctx.fillRect(0, 0, size.w, size.h);
      ctx.strokeStyle = COLOR.grid;
      ctx.lineWidth = 1;
      for (let i = 0; i < size.w; i += 44) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size.h); ctx.stroke();
      }
      for (let i = 0; i < size.h; i += 44) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size.w, i); ctx.stroke();
      }

      const inc = project(incident, center, scale, size);

      if (vehicle) {
        const veh = project(vehicle, center, scale, size);

        // Trayecto: discontinuo para leerse como "estimado", no como ruta real.
        ctx.strokeStyle = COLOR.vehicle;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.moveTo(veh.x, veh.y);
        ctx.lineTo(inc.x, inc.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // Ambulancia
        ctx.fillStyle = COLOR.vehicle;
        ctx.beginPath();
        ctx.arc(veh.x, veh.y, 13, 0, Math.PI * 2);
        ctx.fill();
        // Cruz medica dibujada, no emoji: el emoji depende de la fuente del
        // sistema y se ve distinto (o no se ve) segun el telefono.
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(veh.x - 5, veh.y); ctx.lineTo(veh.x + 5, veh.y);
        ctx.moveTo(veh.x, veh.y - 5); ctx.lineTo(veh.x, veh.y + 5);
        ctx.stroke();
      }

      // Destino: pulso para que se distinga del vehiculo de un vistazo.
      const pulse = reduceMotion ? 1 : 1 + Math.sin(Date.now() / 420) * 0.18;
      ctx.fillStyle = COLOR.target;
      ctx.globalAlpha = 0.2;
      ctx.beginPath();
      ctx.arc(inc.x, inc.y, 22 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLOR.target;
      ctx.beginPath();
      ctx.arc(inc.x, inc.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLOR.bg;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [tracking.incidentLat, tracking.incidentLng]);

  return (
    <div className="relative w-full overflow-hidden rounded-md ring-1 ring-edge-subtle"
         style={{ height: 280 }}>
      {/* El canvas es decorativo; el estado real lo dan el titular, el ETA y la
          línea de tiempo, que sí son texto accesible. */}
      <canvas ref={canvasRef} className="block h-full w-full" role="presentation" />
      <div className="pointer-events-none absolute bottom-3 left-3 flex gap-2 text-[11px]">
        <Legend token="var(--info)" label="Tu ubicación" />
        {tracking.vehicle && (
          <Legend token="var(--emergency)" label={tracking.vehicle.callsign} />
        )}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-slate-950/70 px-2.5 py-1 text-slate-300">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
