import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connectSse, type SseClient } from '../helpers/sse-client.js';
import { createTestApp, uploadArtifact, type TestApp } from '../helpers/test-app.js';

describe('SSE notifications', () => {
  let ctx: TestApp;
  let baseUrl: string;
  const openClients: SseClient[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no listen address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const client of openClients) client.close();
    await ctx.close();
  });

  async function subscribe(systemId: string): Promise<SseClient> {
    const client = await connectSse(`${baseUrl}/api/v1/systems/${systemId}/events`);
    openClients.push(client);
    return client;
  }

  it('delivers artifact.created to a subscriber of the system', async () => {
    const client = await subscribe('sys_sse_one');
    expect(client.headers.get('content-type')).toContain('text/event-stream');

    const uploaded = (
      await uploadArtifact(ctx.app, 'sys_sse_one', {
        filename: 'schema.sql',
        content: 'select 1;',
      })
    ).json();

    const message = await client.next();
    expect(message.event).toBe('artifact.created');
    expect(message.id).toBe(uploaded.id);
    const payload = JSON.parse(message.data ?? '{}');
    expect(payload).toMatchObject({
      id: uploaded.id,
      systemId: 'sys_sse_one',
      name: 'schema.sql',
      version: 1,
    });
    expect(payload.links.content).toBe(uploaded.links.content);
  });

  it('fans the event out to every subscriber of the same system', async () => {
    const first = await subscribe('sys_sse_fan');
    const second = await subscribe('sys_sse_fan');

    const uploaded = (
      await uploadArtifact(ctx.app, 'sys_sse_fan', {
        filename: 'a.txt',
        content: 'x',
      })
    ).json();

    const [messageA, messageB] = await Promise.all([first.next(), second.next()]);
    expect(messageA.id).toBe(uploaded.id);
    expect(messageB.id).toBe(uploaded.id);
  });

  it('scopes events to the subscribed system', async () => {
    const client = await subscribe('sys_sse_b');

    // An upload to another system must not reach this subscriber; the next event
    // this client sees is the one for its own system.
    await uploadArtifact(ctx.app, 'sys_sse_a', { filename: 'other.txt', content: 'x' });
    const own = (
      await uploadArtifact(ctx.app, 'sys_sse_b', {
        filename: 'mine.txt',
        content: 'y',
      })
    ).json();

    const message = await client.next();
    expect(message.id).toBe(own.id);
    expect(JSON.parse(message.data ?? '{}').systemId).toBe('sys_sse_b');
  });

  it('cleans up disconnected subscribers', async () => {
    const client = await connectSse(`${baseUrl}/api/v1/systems/sys_sse_gone/events`);
    await vi.waitFor(() => expect(ctx.sse.connectionCount('sys_sse_gone')).toBe(1));

    client.close();
    await vi.waitFor(() => expect(ctx.sse.connectionCount('sys_sse_gone')).toBe(0));

    // Publishing to a system with no subscribers must not throw.
    const response = await uploadArtifact(ctx.app, 'sys_sse_gone', {
      filename: 'a.txt',
      content: 'x',
    });
    expect(response.statusCode).toBe(201);
  });
});
