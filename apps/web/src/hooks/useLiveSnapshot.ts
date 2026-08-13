'use client';

import type { OperationsSnapshot } from '@dispatch/contracts';
import { useLiveResource } from './useLiveResource';

const TOPICS = ['incident:created', 'incident:updated', 'incident:merged', 'vehicle:updated', 'vehicle:location', 'dispatch:candidates', 'assignment:updated', 'coverage:updated'] as const;

function selectSnapshot(payload: unknown): OperationsSnapshot {
  if (payload && typeof payload === 'object' && 'snapshot' in payload) return payload.snapshot as OperationsSnapshot;
  return payload as OperationsSnapshot;
}

export function useLiveSnapshot(initialData: OperationsSnapshot, endpoint = '/api/command/snapshot') {
  return useLiveResource({ initialData, endpoint, topics: TOPICS, select: selectSnapshot });
}
