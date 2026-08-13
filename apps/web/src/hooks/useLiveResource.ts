'use client';

import type { SseEnvelope, SseTopic } from '@dispatch/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

export type LiveTransport = 'connecting' | 'sse' | 'polling';

export interface LiveResource<T> {
  data: T;
  transport: LiveTransport;
  error: Error | null;
  refresh: () => Promise<void>;
}

interface Options<T> {
  initialData: T;
  endpoint: string;
  topics: readonly SseTopic[];
  select: (payload: unknown) => T;
}

export function useLiveResource<T>({ initialData, endpoint, topics, select }: Options<T>): LiveResource<T> {
  const [data, setData] = useState(initialData);
  const [transport, setTransport] = useState<LiveTransport>('connecting');
  const [error, setError] = useState<Error | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Polling ${endpoint}: HTTP ${response.status}`);
      const next = select(await response.json());
      if (mountedRef.current) {
        setData(next);
        setError(null);
      }
    } catch (caught) {
      if (mountedRef.current) {
        const message = caught instanceof DOMException && caught.name === 'AbortError'
          ? 'El centro de despacho tardó demasiado en responder'
          : caught instanceof Error ? caught.message : 'Error de actualización';
        setError(new Error(message));
      }
    } finally {
      window.clearTimeout(timeout);
    }
  }, [endpoint, select]);

  useEffect(() => {
    mountedRef.current = true;
    let connected = false;
    let source: EventSource | null = null;

    // SSE notifica cambios futuros, pero no hidrata el estado inicial. Hacer
    // una lectura inmediata evita que la UI quede cargando indefinidamente
    // cuando el stream abre correctamente antes del primer evento.
    void refresh();

    const stopPolling = () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = null;
    };
    const startPolling = () => {
      if (pollingRef.current) return;
      setTransport('polling');
      void refresh();
      pollingRef.current = setInterval(() => void refresh(), 3_000);
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
      return () => {
        mountedRef.current = false;
        stopPolling();
      };
    }

    source = new EventSource(`/api/stream?topics=${encodeURIComponent(topics.join(','))}`);
    const connectionTimeout = setTimeout(() => {
      if (!connected) startPolling();
    }, 2_000);

    source.onopen = () => {
      connected = true;
      clearTimeout(connectionTimeout);
      stopPolling();
      setTransport('sse');
      setError(null);
    };
    source.onmessage = (message) => {
      try {
        const envelope = JSON.parse(message.data) as SseEnvelope;
        if (topics.includes(envelope.topic)) void refresh();
      } catch {
        setError(new Error('Evento SSE inválido'));
      }
    };
    source.onerror = () => {
      connected = false;
      startPolling();
    };

    return () => {
      mountedRef.current = false;
      clearTimeout(connectionTimeout);
      stopPolling();
      source?.close();
    };
  }, [refresh, topics]);

  return { data, transport, error, refresh };
}
