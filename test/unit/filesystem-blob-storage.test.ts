import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemBlobStorage } from '../../src/storage/filesystem-blob-storage.js';

function toStream(content: Buffer | string): Readable {
  return Readable.from([Buffer.isBuffer(content) ? content : Buffer.from(content)]);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('FilesystemBlobStorage', () => {
  let root: string;
  let storage: FilesystemBlobStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pit-blob-test-'));
    storage = await FilesystemBlobStorage.create(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips content and reports size and sha256 checksum', async () => {
    const content = Buffer.from('CREATE TABLE artifacts (id uuid primary key);');
    const expectedChecksum = `sha256:${createHash('sha256').update(content).digest('hex')}`;

    const result = await storage.write(
      'sys_alpha',
      'a0000000-0000-4000-8000-000000000001',
      toStream(content),
    );

    expect(result.storageKey).toBe('sys_alpha/a0000000-0000-4000-8000-000000000001');
    expect(result.size).toBe(content.length);
    expect(result.checksum).toBe(expectedChecksum);

    const readBack = await collect(storage.openReadStream(result.storageKey));
    expect(readBack.equals(content)).toBe(true);
  });

  it('removes the blob on delete', async () => {
    const result = await storage.write(
      'sys_alpha',
      'a0000000-0000-4000-8000-000000000002',
      toStream('x'),
    );
    await storage.delete(result.storageKey);
    const files = await readdir(path.join(root, 'sys_alpha'));
    expect(files).toEqual([]);
  });

  it('cleans up the partial file when the source stream fails mid-write', async () => {
    async function* failing(): AsyncGenerator<Buffer> {
      yield Buffer.from('partial content');
      throw new Error('upstream failure');
    }

    await expect(
      storage.write('sys_alpha', 'a0000000-0000-4000-8000-000000000003', Readable.from(failing())),
    ).rejects.toThrow('upstream failure');

    const files = await readdir(path.join(root, 'sys_alpha'));
    expect(files).toEqual([]);
  });

  it('rejects storage keys that escape the storage root', () => {
    expect(() => storage.openReadStream('../outside')).toThrow(/escapes the storage root/);
  });
});
