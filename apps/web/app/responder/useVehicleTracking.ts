'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface QueuedPosition {
  lat: number;
  lng: number;
  heading?: number;
  speedKmh?: number;
  recordedAt: number;
}

export type GpsState = 'waiting' | 'sending' | 'offline' | 'denied' | 'unsupported';

function storageKey(vehicleId: string): string {
  return `dispatch:gps-queue:${vehicleId}`;
}

function readQueue(vehicleId: string): QueuedPosition[] {
  try {
    const raw = localStorage.getItem(storageKey(vehicleId));
    return raw ? (JSON.parse(raw) as QueuedPosition[]) : [];
  } catch {
    return [];
  }
}

export function useVehicleTracking(vehicleId: string | null, enabled: boolean) {
  const [state, setState] = useState<GpsState>('waiting');
  const [queued, setQueued] = useState(0);
  /** Última posición leída del dispositivo, para el mapa de este mismo panel.
   *  Se expone aparte de la cola de envío: subir cada lectura al servidor sería
   *  ruido, pero DIBUJARLAS todas es lo que hace que el conductor se vea moverse
   *  en tiempo real en vez de a saltos de varios segundos. */
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const queueRef = useRef<QueuedPosition[]>([]);
  const sendingRef = useRef(false);
  const lastQueuedAtRef = useRef(0);

  const persist = useCallback((id: string) => {
    localStorage.setItem(storageKey(id), JSON.stringify(queueRef.current));
    setQueued(queueRef.current.length);
  }, []);

  const flush = useCallback(async (id: string) => {
    if (sendingRef.current || queueRef.current.length === 0) return;
    if (!navigator.onLine) {
      setState('offline');
      return;
    }
    sendingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const batch = queueRef.current.slice(0, 100);
        const response = await fetch(`/api/vehicles/${encodeURIComponent(id)}/location`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ positions: batch }),
        });
        if (!response.ok) throw new Error(`GPS HTTP ${response.status}`);
        queueRef.current.splice(0, batch.length);
        persist(id);
      }
      setState('sending');
    } catch {
      setState('offline');
    } finally {
      sendingRef.current = false;
    }
  }, [persist]);

  useEffect(() => {
    if (!vehicleId || !enabled) {
      setState('waiting');
      return;
    }
    const id = vehicleId;
    queueRef.current = readQueue(id);
    setQueued(queueRef.current.length);

    if (!('geolocation' in navigator)) {
      setState('unsupported');
      return;
    }

    const handleOnline = () => void flush(id);
    const handleOffline = () => setState('offline');
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    void flush(id);

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setPosition({ lat: position.coords.latitude, lng: position.coords.longitude });
        const speedKmh = position.coords.speed == null ? undefined : Math.max(0, position.coords.speed * 3.6);
        const moving = (speedKmh ?? 0) >= 3;
        const cadenceMs = moving ? 3_000 : 15_000;
        if (position.timestamp - lastQueuedAtRef.current < cadenceMs) return;
        lastQueuedAtRef.current = position.timestamp;
        queueRef.current.push({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          ...(position.coords.heading == null ? {} : { heading: position.coords.heading }),
          ...(speedKmh == null ? {} : { speedKmh }),
          recordedAt: Math.trunc(position.timestamp),
        });
        persist(id);
        void flush(id);
      },
      (error) => setState(error.code === error.PERMISSION_DENIED ? 'denied' : 'offline'),
      { enableHighAccuracy: true, maximumAge: 2_000, timeout: 20_000 },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [enabled, flush, persist, vehicleId]);

  return { state, queued, position };
}
