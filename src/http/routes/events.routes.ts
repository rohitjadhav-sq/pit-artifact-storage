import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config/config.js';
import type { SseManager } from '../../events/sse-manager.js';
import { systemParamsSchema } from '../schemas.js';

export function registerEventRoutes(
  app: FastifyInstance,
  deps: { sseManager: SseManager; config: Config },
): void {
  app.get('/systems/:systemId/events', (request, reply) => {
    // Validate before hijacking so failures still get the standard error envelope.
    const { systemId } = systemParamsSchema.parse(request.params);

    reply.hijack();
    const response = reply.raw;

    // The reply is hijacked, so plugin hooks (CORS) never run; set headers by hand.
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    };
    const origin = request.headers.origin;
    if (origin && deps.config.corsOrigins.includes(origin)) {
      headers['access-control-allow-origin'] = origin;
      headers['vary'] = 'Origin';
    }
    response.writeHead(200, headers);
    response.write('retry: 5000\n\n: connected\n\n');

    deps.sseManager.add(systemId, response);
    request.log.info({ systemId }, 'sse subscriber connected');
    request.raw.on('close', () => request.log.info({ systemId }, 'sse subscriber disconnected'));
  });
}
