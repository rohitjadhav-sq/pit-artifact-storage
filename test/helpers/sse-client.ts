export interface SseMessage {
  event?: string;
  id?: string;
  data?: string;
}

export interface SseClient {
  headers: Headers;
  next(timeoutMs?: number): Promise<SseMessage>;
  close(): void;
}

function parseBlock(block: string): SseMessage | null {
  const message: SseMessage = {};
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue; // comments / keep-alives
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') message.event = value;
    else if (field === 'id') message.id = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length > 0) message.data = dataLines.join('\n');
  if (!message.event && message.data === undefined) return null; // retry-only block
  return message;
}

/** Minimal SSE client over fetch, good enough to assert on the event stream in tests. */
export async function connectSse(url: string): Promise<SseClient> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`SSE connect failed with status ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pending: SseMessage[] = [];
  const waiters: Array<(message: SseMessage) => void> = [];
  let buffer = '';

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const blockEnd = buffer.indexOf('\n\n');
          if (blockEnd === -1) break;
          const block = buffer.slice(0, blockEnd);
          buffer = buffer.slice(blockEnd + 2);
          const message = parseBlock(block);
          if (!message) continue;
          const waiter = waiters.shift();
          if (waiter) waiter(message);
          else pending.push(message);
        }
      }
    } catch {
      // connection aborted by close()
    }
  })();

  return {
    headers: response.headers,
    next(timeoutMs = 5000) {
      const queued = pending.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<SseMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for SSE event')),
          timeoutMs,
        );
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    close: () => controller.abort(),
  };
}
