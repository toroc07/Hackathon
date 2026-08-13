import type { ActorType, IncidentEvent, IncidentEventType } from '@dispatch/contracts';
import { newId, type Queryable } from '@/src/server/infra/db';

export interface AppendEventInput {
  incidentId: string;
  eventType: IncidentEventType;
  actorType: ActorType;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export async function appendIncidentEvent(q: Queryable, input: AppendEventInput): Promise<IncidentEvent> {
  const event: IncidentEvent = {
    id: newId(input.createdAt),
    incidentId: input.incidentId,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? Date.now(),
  };
  await q.run(`
    INSERT INTO incident_events (id, incident_id, event_type, actor_type, actor_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [event.id, event.incidentId, event.eventType, event.actorType, event.actorId, JSON.stringify(event.metadata), event.createdAt]);
  return event;
}
