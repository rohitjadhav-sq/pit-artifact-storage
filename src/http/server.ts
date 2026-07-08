import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/config.js';
import type { EventBus } from '../events/event-bus.js';
import type { SseManager } from '../events/sse-manager.js';
import type { ArtifactService } from '../services/artifact-service.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { registerArtifactRoutes } from './routes/artifacts.routes.js';
import { registerDemoRoutes } from './routes/demo.routes.js';
import { registerEventRoutes } from './routes/events.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { serializeArtifact } from './serialize.js';

export interface AppDeps {
  config: Config;
  artifactService: ArtifactService;
  sseManager: SseManager;
  eventBus: EventBus;
  /** Resolves when the metadata store is reachable; rejects otherwise. */
  readiness: () => Promise<void>;
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;

  const app = Fastify({
    logger: { level: config.logLevel },
    forceCloseConnections: true,
  });

  await app.register(helmet);
  await app.register(cors, { origin: config.corsOrigins });
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 20,
      fieldSize: 1024,
    },
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  registerHealthRoutes(app, deps);
  registerDemoRoutes(app);

  await app.register(
    async (api) => {
      registerArtifactRoutes(api, deps);
      registerEventRoutes(api, deps);
    },
    { prefix: '/api/v1' },
  );

  // Fan domain events out to the SSE subscribers of the affected system.
  const unsubscribe = deps.eventBus.subscribe((event) => {
    if (event.type === 'artifact.created') {
      deps.sseManager.send(event.systemId, {
        event: event.type,
        id: event.artifact.id,
        data: serializeArtifact(event.artifact),
      });
    }
  });

  app.addHook('onClose', async () => {
    unsubscribe();
    deps.sseManager.close();
  });

  return app;
}
