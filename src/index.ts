import { loadConfig } from './config/config.js';
import { createDb, createPool } from './db/client.js';
import { runMigrations } from './db/migrations.js';
import { InProcessEventBus } from './events/event-bus.js';
import { SseManager } from './events/sse-manager.js';
import { buildServer } from './http/server.js';
import { DrizzleArtifactRepository } from './repositories/drizzle-artifact-repository.js';
import { ArtifactService } from './services/artifact-service.js';
import { FilesystemBlobStorage } from './storage/filesystem-blob-storage.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function withRetries<T>(attempts: number, delayMs: number, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.error(`startup dependency not ready (attempt ${attempt}/${attempts}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool(config.databaseUrl);
  // docker-compose gates startup on the db healthcheck; the retry covers plain `npm run dev`.
  await withRetries(5, 2000, () => runMigrations(pool));
  const db = createDb(pool);

  const repository = new DrizzleArtifactRepository(db);
  const storage = await FilesystemBlobStorage.create(config.storageRoot);
  const eventBus = new InProcessEventBus();
  const sseManager = new SseManager(config.sseKeepAliveMs);
  const artifactService = new ArtifactService(repository, storage, eventBus);

  const app = await buildServer({
    config,
    artifactService,
    sseManager,
    eventBus,
    readiness: async () => {
      await pool.query('SELECT 1');
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    const killTimer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    killTimer.unref();
    try {
      await app.close(); // drains HTTP + ends SSE connections (onClose hook)
      await pool.end();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error) => {
  console.error('fatal startup error:', error);
  process.exit(1);
});
