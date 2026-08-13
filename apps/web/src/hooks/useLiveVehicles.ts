'use client';

import type { VehicleWithLocation } from '@dispatch/contracts';
import { useLiveResource } from './useLiveResource';

const TOPICS = ['vehicle:updated', 'vehicle:location', 'assignment:updated'] as const;

function selectVehicles(payload: unknown): VehicleWithLocation[] {
  if (Array.isArray(payload)) return payload as VehicleWithLocation[];
  if (payload && typeof payload === 'object' && 'vehicles' in payload && Array.isArray(payload.vehicles)) return payload.vehicles as VehicleWithLocation[];
  throw new Error('GET /api/vehicles no devolvió una colección de vehículos');
}

export function useLiveVehicles(initialData: VehicleWithLocation[] = []) {
  return useLiveResource({ initialData, endpoint: '/api/vehicles', topics: TOPICS, select: selectVehicles });
}
