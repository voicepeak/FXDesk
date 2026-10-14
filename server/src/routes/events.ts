import type { FastifyInstance } from 'fastify';
import { bus } from '../sse';
import { queueManager } from '../queue';

export function registerEventsRoutes(app: FastifyInstance): void {
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const client = bus.add(reply.raw);
    try {
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify({ queue: queueManager.snapshot() })}\n\n`);
    } catch {
      /* ignore */
    }

    const ping = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);

    req.raw.on('close', () => {
      clearInterval(ping);
      bus.remove(client);
    });
    return reply;
  });
}
