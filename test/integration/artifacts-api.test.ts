import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  multipartPayload,
  uploadArtifact,
  type TestApp,
} from '../helpers/test-app.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('artifacts API', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  describe('POST /api/v1/systems/:systemId/artifacts', () => {
    it('stores the file and returns 201 with full metadata', async () => {
      const content = 'CREATE TABLE users (id uuid primary key);';
      const response = await uploadArtifact(ctx.app, 'sys_alpha', {
        filename: 'schema.sql',
        content,
        contentType: 'application/sql',
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.id).toMatch(UUID_RE);
      expect(body).toMatchObject({
        systemId: 'sys_alpha',
        name: 'schema.sql',
        contentType: 'application/sql',
        size: content.length,
        version: 1,
        checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      });
      expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
      expect(body.links).toEqual({
        self: `/api/v1/systems/sys_alpha/artifacts/${body.id}`,
        content: `/api/v1/systems/sys_alpha/artifacts/${body.id}/content`,
      });

      // The blob is on disk under server-generated IDs only.
      const blob = await readFile(path.join(ctx.storageRoot, 'sys_alpha', body.id), 'utf8');
      expect(blob).toBe(content);
    });

    it('increments the version when the same name is uploaded again', async () => {
      const first = await uploadArtifact(ctx.app, 'sys_alpha', {
        filename: 'a.txt',
        content: 'v1',
      });
      const second = await uploadArtifact(ctx.app, 'sys_alpha', {
        filename: 'a.txt',
        content: 'v2',
      });
      expect(first.json().version).toBe(1);
      expect(second.json().version).toBe(2);
    });

    it('honours a "name" field sent before the file part', async () => {
      const response = await uploadArtifact(
        ctx.app,
        'sys_alpha',
        { filename: 'upload.tmp', content: 'x' },
        'renamed.sql',
      );
      expect(response.statusCode).toBe(201);
      expect(response.json().name).toBe('renamed.sql');
    });

    it('returns 400 when the multipart body has no file part', async () => {
      const { payload, headers } = multipartPayload([
        { kind: 'field', name: 'name', value: 'no-file' },
      ]);
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/systems/sys_alpha/artifacts',
        payload,
        headers,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 415 for a non-multipart body', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/systems/sys_alpha/artifacts',
        payload: { hello: 'world' },
      });
      expect(response.statusCode).toBe(415);
      expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('returns 400 for an invalid systemId', async () => {
      const response = await uploadArtifact(ctx.app, 'not%20valid', {
        filename: 'a.txt',
        content: 'x',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('upload size limit', () => {
    it('rejects oversize uploads with 413', async () => {
      const small = await createTestApp({ maxUploadBytes: 16 });
      try {
        const response = await uploadArtifact(small.app, 'sys_alpha', {
          filename: 'big.bin',
          content: Buffer.alloc(64, 1),
        });
        expect(response.statusCode).toBe(413);
        expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
        // The truncated blob must not be left behind.
        await expect(readdir(path.join(small.storageRoot, 'sys_alpha'))).resolves.toEqual([]);
      } finally {
        await small.close();
      }
    });
  });

  describe('GET /api/v1/systems/:systemId/artifacts', () => {
    it('lists artifacts with pagination metadata', async () => {
      await uploadArtifact(ctx.app, 'sys_alpha', { filename: 'a.txt', content: '1' });
      await uploadArtifact(ctx.app, 'sys_alpha', { filename: 'a.txt', content: '2' });
      await uploadArtifact(ctx.app, 'sys_alpha', { filename: 'b.txt', content: '3' });

      const response = await ctx.app.inject({ url: '/api/v1/systems/sys_alpha/artifacts' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(3);
      expect(body.pagination).toEqual({ limit: 50, offset: 0, total: 3 });
    });

    it('applies limit and offset', async () => {
      for (const n of ['a', 'b', 'c']) {
        await uploadArtifact(ctx.app, 'sys_alpha', { filename: `${n}.txt`, content: n });
      }
      const response = await ctx.app.inject({
        url: '/api/v1/systems/sys_alpha/artifacts?limit=1&offset=1',
      });
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination).toEqual({ limit: 1, offset: 1, total: 3 });
    });

    it('filters by name, returning all versions', async () => {
      await uploadArtifact(ctx.app, 'sys_alpha', { filename: 'a.txt', content: '1' });
      await uploadArtifact(ctx.app, 'sys_alpha', { filename: 'a.txt', content: '2' });
      await uploadArtifact(ctx.app, 'sys_alpha', { filename: 'b.txt', content: '3' });

      const response = await ctx.app.inject({
        url: '/api/v1/systems/sys_alpha/artifacts?name=a.txt',
      });
      const body = response.json();
      expect(body.data).toHaveLength(2);
      expect(body.data.map((a: { version: number }) => a.version).sort()).toEqual([1, 2]);
    });

    it('returns an empty array for a system with no artifacts', async () => {
      const response = await ctx.app.inject({ url: '/api/v1/systems/sys_empty/artifacts' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: [],
        pagination: { limit: 50, offset: 0, total: 0 },
      });
    });

    it('rejects out-of-bounds pagination values', async () => {
      const response = await ctx.app.inject({
        url: '/api/v1/systems/sys_alpha/artifacts?limit=9999',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/systems/:systemId/artifacts/:artifactId', () => {
    it('returns the metadata for an existing artifact', async () => {
      const uploaded = (
        await uploadArtifact(ctx.app, 'sys_alpha', {
          filename: 'a.txt',
          content: 'x',
        })
      ).json();
      const response = await ctx.app.inject({ url: uploaded.links.self });
      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(uploaded.id);
    });

    it('returns 404 for an unknown artifact and 400 for a malformed id', async () => {
      const missing = await ctx.app.inject({
        url: '/api/v1/systems/sys_alpha/artifacts/9f1c2b0e-6d3a-4b2f-9c1a-2b3c4d5e6f70',
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('NOT_FOUND');

      const malformed = await ctx.app.inject({
        url: '/api/v1/systems/sys_alpha/artifacts/not-a-uuid',
      });
      expect(malformed.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/systems/:systemId/artifacts/:artifactId/content', () => {
    it('streams the exact stored bytes with download headers', async () => {
      const content = Buffer.from('artifact bytes åäö');
      const uploaded = (
        await uploadArtifact(ctx.app, 'sys_alpha', {
          filename: 'report.bin',
          content,
          contentType: 'application/octet-stream',
        })
      ).json();

      const response = await ctx.app.inject({ url: uploaded.links.content });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.equals(content)).toBe(true);
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.headers['content-length']).toBe(String(content.length));
      expect(response.headers['content-disposition']).toContain('filename="report.bin"');
    });

    it('returns 404 for a missing artifact', async () => {
      const response = await ctx.app.inject({
        url: '/api/v1/systems/sys_alpha/artifacts/9f1c2b0e-6d3a-4b2f-9c1a-2b3c4d5e6f70/content',
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('infrastructure endpoints', () => {
    it('serves liveness and readiness health checks', async () => {
      const health = await ctx.app.inject({ url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok' });

      const ready = await ctx.app.inject({ url: '/health/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.database).toBe('ok');
    });

    it('answers CORS preflight for an allowed origin', async () => {
      const response = await ctx.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/systems/sys_alpha/artifacts',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
        },
      });
      expect(response.statusCode).toBeLessThan(300);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });

    it('returns the error envelope for unknown routes', async () => {
      const response = await ctx.app.inject({ url: '/api/v1/nope' });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    });
  });
});
