import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BlobStorage, BlobWriteResult } from './blob-storage.js';

/** Pass-through transform that counts bytes and folds them into a sha256 digest. */
class HashingCounter extends Transform {
  private readonly hash = createHash('sha256');
  bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    callback(null, chunk);
  }

  digestHex(): string {
    return this.hash.digest('hex');
  }
}

/**
 * Stores blobs under `${root}/${systemId}/${artifactId}`. Both path segments are
 * server-generated/validated IDs; user-supplied filenames never reach the filesystem.
 */
export class FilesystemBlobStorage implements BlobStorage {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FilesystemBlobStorage> {
    const resolved = path.resolve(root);
    await mkdir(resolved, { recursive: true });
    return new FilesystemBlobStorage(resolved);
  }

  private resolveKey(storageKey: string): string {
    const absolute = path.resolve(this.root, storageKey);
    if (!absolute.startsWith(this.root + path.sep)) {
      throw new Error(`storage key escapes the storage root: ${storageKey}`);
    }
    return absolute;
  }

  async write(systemId: string, artifactId: string, data: Readable): Promise<BlobWriteResult> {
    const storageKey = `${systemId}/${artifactId}`;
    const target = this.resolveKey(storageKey);
    await mkdir(path.dirname(target), { recursive: true });

    const hasher = new HashingCounter();
    try {
      // 'wx' fails on an existing file; artifact IDs are fresh UUIDs so a clash means a bug.
      await pipeline(data, hasher, createWriteStream(target, { flags: 'wx' }));
    } catch (error) {
      await rm(target, { force: true }).catch(() => {});
      throw error;
    }

    return { storageKey, size: hasher.bytes, checksum: `sha256:${hasher.digestHex()}` };
  }

  openReadStream(storageKey: string): Readable {
    return createReadStream(this.resolveKey(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.resolveKey(storageKey), { force: true });
  }
}
