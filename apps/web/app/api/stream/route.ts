import { SSE_TOPICS, type SseEnvelope, type SseTopic } from '@dispatch/contracts';
import { bus } from '@/src/server/infra/bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

function requestedTopics(request: Request): SseTopic[] {
  const raw = new URL(request.url).searchParams.get('topics');
  if (!raw) return [...SSE_TOPICS];
  const requested = [...new Set(raw.split(',').map((topic) => topic.trim()).filter(Boolean))];
  const allowed = new Set<string>(SSE_TOPICS);
  const invalid = requested.filter((topic) => !allowed.has(topic));
  if (invalid.length > 0) throw new Error(`Topics SSE desconocidos: ${invalid.join(', ')}`);
  return requested as SseTopic[];
}

function encodeEvent(event: SseEnvelope): Uint8Array {
  return encoder.encode(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
}

export function GET(request: Request): Response {
  let topics: SseTopic[];
  try {
    topics = requestedTopics(request);
  } catch (error) {
    return Response.json({ error: { code: 'VALIDATION_FAILED', message: error instanceof Error ? error.message : 'Topics inválidos' } }, { status: 400 });
  }

  let dispose = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ topics, connectedAt: Date.now() })}\n\n`));
      dispose = bus.subscribe(topics, (event) => {
        if (!closed) controller.enqueue(encodeEvent(event));
      });
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, 15_000);

      const close = () => {
        if (closed) return;
        closed = true;
        dispose();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* El cliente ya cerró el stream. */ }
      };
      request.signal.addEventListener('abort', close, { once: true });
    },
    cancel() {
      closed = true;
      dispose();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
