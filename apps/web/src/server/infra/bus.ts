import { SSE_TOPICS, type SseEnvelope, type SseTopic } from '@dispatch/contracts';

export type BusListener = (event: SseEnvelope) => void;

class InMemoryEventBus {
  private readonly listeners = new Map<SseTopic, Set<BusListener>>(
    SSE_TOPICS.map((topic) => [topic, new Set<BusListener>()]),
  );

  emit<TPayload>(topic: SseTopic, payload: TPayload): SseEnvelope {
    const event: SseEnvelope = { topic, payload, emittedAt: Date.now() };
    for (const listener of this.listeners.get(topic) ?? []) {
      try {
        listener(event);
      } catch (error) {
        queueMicrotask(() => { throw error; });
      }
    }
    return event;
  }

  subscribe(topics: readonly SseTopic[], listener: BusListener): () => void {
    for (const topic of topics) this.listeners.get(topic)?.add(listener);
    return () => {
      for (const topic of topics) this.listeners.get(topic)?.delete(listener);
    };
  }

  listenerCount(topic: SseTopic): number {
    return this.listeners.get(topic)?.size ?? 0;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __dispatchEventBus: InMemoryEventBus | undefined;
}

export const bus = globalThis.__dispatchEventBus ??= new InMemoryEventBus();
