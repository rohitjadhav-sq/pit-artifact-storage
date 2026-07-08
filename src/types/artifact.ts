export interface Artifact {
  id: string;
  systemId: string;
  name: string;
  contentType: string;
  size: number;
  version: number;
  checksum: string;
  storageKey: string;
  createdAt: Date;
}

/** Everything the repository needs to persist an artifact; the version is assigned on insert. */
export type NewArtifact = Omit<Artifact, 'version'>;

export interface ArtifactListQuery {
  limit: number;
  offset: number;
  name?: string;
}

export interface ArtifactPage {
  items: Artifact[];
  total: number;
}
