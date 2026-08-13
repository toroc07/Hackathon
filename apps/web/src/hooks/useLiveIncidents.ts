'use client';

import type { Incident } from '@dispatch/contracts';
import { useLiveResource } from './useLiveResource';

const TOPICS = ['incident:created', 'incident:updated', 'incident:merged', 'assignment:updated'] as const;

function selectIncidents(payload: unknown): Incident[] {
  if (Array.isArray(payload)) return payload as Incident[];
  if (payload && typeof payload === 'object' && 'incidents' in payload && Array.isArray(payload.incidents)) return payload.incidents as Incident[];
  throw new Error('GET /api/incidents no devolvió una colección de incidentes');
}

export function useLiveIncidents(initialData: Incident[] = []) {
  return useLiveResource({ initialData, endpoint: '/api/incidents', topics: TOPICS, select: selectIncidents });
}
