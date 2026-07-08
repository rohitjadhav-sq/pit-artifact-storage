import type { Artifact } from '../types/artifact.js';

export interface ArtifactCreatedEvent {
  type: 'artifact.created';
  systemId: string;
  artifact: Artifact;
}

export type DomainEvent = ArtifactCreatedEvent;

export type EventHandler = (event: DomainEvent) => void;

export interface EventBus {
  publish(event: DomainEvent): void;
  /** Returns an unsubscribe function. */
  subscribe(handler: EventHandler): () => void;
}

/**
 * Single-process pub/sub. Swapping this for a shared broker (e.g. Redis) is the
 * documented path to multi-instance SSE delivery.
 */
export class InProcessEventBus implements EventBus {
  private readonly handlers = new Set<EventHandler>();

  publish(event: DomainEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // A faulty subscriber must never break the publisher (the upload request).
      }
    }
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
