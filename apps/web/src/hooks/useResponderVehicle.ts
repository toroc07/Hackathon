'use client';

import type { Assignment, Incident, VehicleWithLocation } from '@dispatch/contracts';
import { useEffect } from 'react';
import { useLiveResource } from './useLiveResource';

const TOPICS = ['vehicle:updated', 'vehicle:location', 'assignment:updated'] as const;

export interface ResponderVehicleData {
  vehicle: VehicleWithLocation | null;
  activeAssignment: { assignment: Assignment; incident: Incident } | null;
  /** Resumen del reporte que estructuró la IA — lo que el panel muestra tal cual. */
  reportSummary: string | null;
  /** Teléfono de algún reporte del incidente activo, para "Llamar al
   *  ciudadano" — null si no hay asignación o el reporte no dejó contacto. */
  reporterContact: string | null;
}

function selectResponderVehicle(payload: unknown): ResponderVehicleData {
  if (!payload || typeof payload !== 'object' || !('vehicle' in payload)) {
    throw new Error('Respuesta de vehículo inválida');
  }
  return payload as ResponderVehicleData;
}

export function useResponderVehicle(vehicleId: string | null) {
  const live = useLiveResource({
    initialData: { vehicle: null, activeAssignment: null, reportSummary: null, reporterContact: null },
    endpoint: vehicleId ? `/api/vehicles/${encodeURIComponent(vehicleId)}` : '/api/vehicles/__none__',
    topics: TOPICS,
    select: selectResponderVehicle,
  });
  // Las ofertas duran sólo 30s. Este sondeo local complementa SSE para que una
  // oferta nunca dependa de que otro dominio haya emitido un evento.
  useEffect(() => {
    if (!vehicleId) return;
    const timer = window.setInterval(() => void live.refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [live.refresh, vehicleId]);
  return live;
}
