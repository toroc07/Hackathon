import type { ActorType, IncidentEvent, IncidentEventType } from '@dispatch/contracts';
import { newId, type SqliteDatabase } from '@/src/server/infra/db';

export interface AppendEventInput {
  incidentId: string;
  eventType: IncidentEventType;
  actorType: ActorType;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export function appendIncidentEvent(db: SqliteDatabase, input: AppendEventInput): IncidentEvent {
  const event: IncidentEvent = {
    id: newId(input.createdAt),
    incidentId: input.incidentId,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? Date.now(),
  };
  db.prepare(`
    INSERT INTO incident_events (id, incident_id, event_type, actor_type, actor_id, metadata, created_at)
    VALUES (@id, @incidentId, @eventType, @actorType, @actorId, @metadata, @createdAt)
  `).run({ ...event, metadata: JSON.stringify(event.metadata) });
  return event;
}
