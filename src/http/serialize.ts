import type { Artifact } from '../types/artifact.js';

export interface ArtifactResponse {
  id: string;
  systemId: string;
  name: string;
  contentType: string;
  size: number;
  version: number;
  checksum: string;
  createdAt: string;
  links: { self: string; content: string };
}

export function serializeArtifact(artifact: Artifact): ArtifactResponse {
  const self = `/api/v1/systems/${artifact.systemId}/artifacts/${artifact.id}`;
  return {
    id: artifact.id,
    systemId: artifact.systemId,
    name: artifact.name,
    contentType: artifact.contentType,
    size: artifact.size,
    version: artifact.version,
    checksum: artifact.checksum,
    createdAt: artifact.createdAt.toISOString(),
    links: { self, content: `${self}/content` },
  };
}

/** RFC 6266/5987 Content-Disposition with an ASCII fallback for arbitrary artifact names. */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^ -~]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
