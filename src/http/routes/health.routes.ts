import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { readiness: () => Promise<void> },
): void {
  // Liveness: the process is up and serving requests.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: dependencies (metadata store) are reachable.
  app.get('/health/ready', async (_request, reply) => {
    try {
      await deps.readiness();
      return { status: 'ok', checks: { database: 'ok' } };
    } catch {
      return reply.code(503).send({ status: 'unavailable', checks: { database: 'unavailable' } });
    }
  });
}
