import type { ServerResponse } from 'node:http';

export interface SseEvent {
  event: string;
  id?: string;
  data: unknown;
}

function formatFrame({ event, id, data }: SseEvent): string {
  let frame = `event: ${event}\n`;
  if (id) frame += `id: ${id}\n`;
  frame += `data: ${JSON.stringify(data)}\n\n`;
  return frame;
}

/**
 * Registry of open SSE connections keyed by systemId. Adding/removing a subscriber is O(1);
 * fan-out is O(subscribers of that system). A single timer keeps all connections alive.
 */
export class SseManager {
  private readonly subscribers = new Map<string, Set<ServerResponse>>();
  private readonly keepAliveTimer: NodeJS.Timeout;

  constructor(keepAliveMs: number) {
    this.keepAliveTimer = setInterval(() => this.writeToAll(': keep-alive\n\n'), keepAliveMs);
    this.keepAliveTimer.unref();
  }

  add(systemId: string, response: ServerResponse): void {
    let set = this.subscribers.get(systemId);
    if (!set) {
      set = new Set();
      this.subscribers.set(systemId, set);
    }
    set.add(response);
    response.on('close', () => this.remove(systemId, response));
  }

  private remove(systemId: string, response: ServerResponse): void {
    const set = this.subscribers.get(systemId);
    if (!set) return;
    set.delete(response);
    if (set.size === 0) this.subscribers.delete(systemId);
  }

  send(systemId: string, event: SseEvent): void {
    const set = this.subscribers.get(systemId);
    if (!set) return;
    const frame = formatFrame(event);
    for (const response of set) response.write(frame);
  }

  connectionCount(systemId: string): number {
    return this.subscribers.get(systemId)?.size ?? 0;
  }

  private writeToAll(payload: string): void {
    for (const set of this.subscribers.values()) {
      for (const response of set) response.write(payload);
    }
  }

  /** Ends every open connection; used on graceful shutdown. */
  close(): void {
    clearInterval(this.keepAliveTimer);
    for (const set of this.subscribers.values()) {
      for (const response of set) response.end();
    }
    this.subscribers.clear();
  }
}
