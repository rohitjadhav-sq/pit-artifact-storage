import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InProcessEventBus, type DomainEvent } from '../../src/events/event-bus.js';
import type { ArtifactRepository } from '../../src/repositories/artifact-repository.js';
import { ArtifactService } from '../../src/services/artifact-service.js';
import { FilesystemBlobStorage } from '../../src/storage/filesystem-blob-storage.js';
import { InMemoryArtifactRepository } from '../helpers/in-memory-artifact-repository.js';

function toStream(content: string): Readable {
  return Readable.from([Buffer.from(content)]);
}

describe('ArtifactService', () => {
  let root: string;
  let storage: FilesystemBlobStorage;
  let repository: InMemoryArtifactRepository;
  let bus: InProcessEventBus;
  let service: ArtifactService;
  let events: DomainEvent[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pit-service-test-'));
    storage = await FilesystemBlobStorage.create(root);
    repository = new InMemoryArtifactRepository();
    bus = new InProcessEventBus();
    events = [];
    bus.subscribe((event) => events.push(event));
    service = new ArtifactService(repository, storage, bus);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const upload = (name: string, content = 'content') =>
    service.upload({
      systemId: 'sys_alpha',
      name,
      contentType: 'text/plain',
      content: toStream(content),
    });

  it('assigns version 1 to a new name and increments on re-upload', async () => {
    const first = await upload('schema.sql');
    const second = await upload('schema.sql');
    const other = await upload('app.config.json');

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(other.version).toBe(1);
    // Prior versions are kept, not overwritten.
    expect(first.id).not.toBe(second.id);
    expect((await service.list('sys_alpha', { limit: 50, offset: 0 })).total).toBe(3);
  });

  it('publishes artifact.created for each successful upload', async () => {
    const artifact = await upload('schema.sql');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'artifact.created',
      systemId: 'sys_alpha',
      artifact: { id: artifact.id, name: 'schema.sql', version: 1 },
    });
  });

  it('deletes the blob and publishes nothing when the metadata insert fails', async () => {
    const failingRepository: ArtifactRepository = {
      ensureSystem: async () => {},
      create: async () => {
        throw new Error('db down');
      },
      list: async () => ({ items: [], total: 0 }),
      findById: async () => null,
    };
    const failingService = new ArtifactService(failingRepository, storage, bus);

    await expect(
      failingService.upload({
        systemId: 'sys_alpha',
        name: 'schema.sql',
        contentType: 'text/plain',
        content: toStream('data'),
      }),
    ).rejects.toThrow('db down');

    expect(await readdir(path.join(root, 'sys_alpha'))).toEqual([]);
    expect(events).toHaveLength(0);
  });
});
