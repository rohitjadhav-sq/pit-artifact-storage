import type { Readable } from 'node:stream';

export interface BlobWriteResult {
  storageKey: string;
  size: number;
  checksum: string;
}

export interface BlobStorage {
  /** Streams the data to storage and returns the key, byte count, and sha256 checksum. */
  write(systemId: string, artifactId: string, data: Readable): Promise<BlobWriteResult>;
  openReadStream(storageKey: string): Readable;
  delete(storageKey: string): Promise<void>;
}
