import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Config } from '../../src/config/config.js';
import { InProcessEventBus } from '../../src/events/event-bus.js';
import { SseManager } from '../../src/events/sse-manager.js';
import { buildServer } from '../../src/http/server.js';
import { ArtifactService } from '../../src/services/artifact-service.js';
import { FilesystemBlobStorage } from '../../src/storage/filesystem-blob-storage.js';
import { InMemoryArtifactRepository } from './in-memory-artifact-repository.js';

export interface TestApp {
  app: FastifyInstance;
  storageRoot: string;
  repository: InMemoryArtifactRepository;
  bus: InProcessEventBus;
  sse: SseManager;
  close(): Promise<void>;
}

/**
 * Full application wired against the in-memory repository and a temp-dir blob store,
 * so HTTP behaviour (routes, streaming, SSE) is exercised without PostgreSQL.
 */
export async function createTestApp(
  overrides: Partial<Pick<Config, 'maxUploadBytes'>> = {},
): Promise<TestApp> {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'pit-artifacts-test-'));
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    storageRoot,
    maxUploadBytes: overrides.maxUploadBytes ?? 10 * 1024 * 1024,
    databaseUrl: 'postgres://unused',
    corsOrigins: ['http://localhost:5173'],
    sseKeepAliveMs: 60_000,
    logLevel: 'silent',
  };

  const repository = new InMemoryArtifactRepository();
  const storage = await FilesystemBlobStorage.create(storageRoot);
  const bus = new InProcessEventBus();
  const sse = new SseManager(config.sseKeepAliveMs);
  const artifactService = new ArtifactService(repository, storage, bus);
  const app = await buildServer({
    config,
    artifactService,
    sseManager: sse,
    eventBus: bus,
    readiness: async () => {},
  });

  return {
    app,
    storageRoot,
    repository,
    bus,
    sse,
    close: async () => {
      await app.close();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

type Part =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; contentType: string; content: Buffer | string };

export function multipartPayload(parts: Part[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = 'pit-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.kind === 'field') {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`),
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
        ),
      );
      chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
      chunks.push(Buffer.from('\r\n'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export async function uploadArtifact(
  app: FastifyInstance,
  systemId: string,
  file: { filename: string; content: Buffer | string; contentType?: string },
  nameOverride?: string,
): Promise<LightMyRequestResponse> {
  const parts: Part[] = [];
  if (nameOverride !== undefined) {
    parts.push({ kind: 'field', name: 'name', value: nameOverride });
  }
  parts.push({
    kind: 'file',
    name: 'file',
    filename: file.filename,
    contentType: file.contentType ?? 'application/octet-stream',
    content: file.content,
  });
  const { payload, headers } = multipartPayload(parts);
  return app.inject({
    method: 'POST',
    url: `/api/v1/systems/${systemId}/artifacts`,
    payload,
    headers,
  });
}
