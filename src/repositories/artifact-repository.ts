import type { Artifact, ArtifactListQuery, ArtifactPage, NewArtifact } from '../types/artifact.js';

export interface ArtifactRepository {
  /** Lazily creates the system (and a placeholder customer) so uploads need no seeding. */
  ensureSystem(systemId: string): Promise<void>;
  /** Persists the artifact, atomically assigning the next version for (systemId, name). */
  create(input: NewArtifact): Promise<Artifact>;
  list(systemId: string, query: ArtifactListQuery): Promise<ArtifactPage>;
  findById(systemId: string, artifactId: string): Promise<Artifact | null>;
}
