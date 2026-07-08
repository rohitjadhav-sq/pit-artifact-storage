import type { ArtifactRepository } from '../../src/repositories/artifact-repository.js';
import type {
  Artifact,
  ArtifactListQuery,
  ArtifactPage,
  NewArtifact,
} from '../../src/types/artifact.js';

/** Test double mirroring the versioning/list semantics of the Drizzle repository. */
export class InMemoryArtifactRepository implements ArtifactRepository {
  private readonly artifacts: Artifact[] = [];
  readonly systems = new Set<string>();

  async ensureSystem(systemId: string): Promise<void> {
    this.systems.add(systemId);
  }

  async create(input: NewArtifact): Promise<Artifact> {
    const version =
      this.artifacts
        .filter((a) => a.systemId === input.systemId && a.name === input.name)
        .reduce((max, a) => Math.max(max, a.version), 0) + 1;
    const artifact: Artifact = { ...input, version };
    this.artifacts.push(artifact);
    return artifact;
  }

  async list(systemId: string, query: ArtifactListQuery): Promise<ArtifactPage> {
    const filtered = this.artifacts
      .filter((a) => a.systemId === systemId && (!query.name || a.name === query.name))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.version - a.version);
    return {
      items: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
    };
  }

  async findById(systemId: string, artifactId: string): Promise<Artifact | null> {
    return this.artifacts.find((a) => a.systemId === systemId && a.id === artifactId) ?? null;
  }
}
