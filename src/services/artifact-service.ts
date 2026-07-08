import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { EventBus } from '../events/event-bus.js';
import { notFound } from '../http/errors.js';
import type { ArtifactRepository } from '../repositories/artifact-repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import type { Artifact, ArtifactListQuery, ArtifactPage } from '../types/artifact.js';

export interface UploadInput {
  systemId: string;
  name: string;
  contentType: string;
  content: Readable;
  /**
   * Runs after the blob is fully written but before metadata is persisted; throwing here
   * discards the blob and aborts the upload. Used by the HTTP layer to reject uploads
   * that were truncated at the multipart size limit.
   */
  afterWrite?: () => void;
}

export class ArtifactService {
  constructor(
    private readonly repository: ArtifactRepository,
    private readonly storage: BlobStorage,
    private readonly events: EventBus,
  ) {}

  async upload(input: UploadInput): Promise<Artifact> {
    await this.repository.ensureSystem(input.systemId);

    const id = randomUUID();
    // Blob first, metadata second: a failed blob write never creates a metadata row,
    // and a failed metadata insert cleans the blob up; no orphans either way.
    const written = await this.storage.write(input.systemId, id, input.content);

    let artifact: Artifact;
    try {
      input.afterWrite?.();
      artifact = await this.repository.create({
        id,
        systemId: input.systemId,
        name: input.name,
        contentType: input.contentType,
        size: written.size,
        checksum: written.checksum,
        storageKey: written.storageKey,
        createdAt: new Date(),
      });
    } catch (error) {
      await this.storage.delete(written.storageKey).catch(() => {});
      throw error;
    }

    this.events.publish({ type: 'artifact.created', systemId: artifact.systemId, artifact });
    return artifact;
  }

  list(systemId: string, query: ArtifactListQuery): Promise<ArtifactPage> {
    return this.repository.list(systemId, query);
  }

  async getById(systemId: string, artifactId: string): Promise<Artifact> {
    const artifact = await this.repository.findById(systemId, artifactId);
    if (!artifact) throw notFound('Artifact not found.');
    return artifact;
  }

  async openContent(
    systemId: string,
    artifactId: string,
  ): Promise<{ artifact: Artifact; stream: Readable }> {
    const artifact = await this.getById(systemId, artifactId);
    return { artifact, stream: this.storage.openReadStream(artifact.storageKey) };
  }
}
