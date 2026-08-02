import { Injectable, Logger } from '@nestjs/common';
import {
  DomainEventEnvelope,
  DomainEventHandler,
  DomainEventName,
} from './domain-events';
import { EventRepository } from '../database/repositories/tenant.repositories';
import { RequestContextStore } from '../shared/context/request-context';

/**
 * In-process publish/subscribe with durable persistence.
 *
 * Two properties matter here:
 *
 *  - **Publishing never breaks the publisher.** A throwing subscriber is
 *    logged and swallowed. Creating a worker must not fail because an
 *    analytics listener has a bug.
 *  - **Every event is written to the `events` table before dispatch,** so a
 *    subscriber added later can replay history, and so the audit trail does
 *    not depend on any listener being registered at the time.
 *
 * Cross-process fan-out (BullMQ / Supabase Realtime) plugs in behind the same
 * `publish` call in a later phase without touching callers.
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);
  private readonly handlers = new Map<string, Set<DomainEventHandler>>();
  private readonly wildcards = new Set<DomainEventHandler>();

  constructor(private readonly events: EventRepository) {}

  /** Subscribe to one event name. Returns an unsubscribe function. */
  on(name: DomainEventName | string, handler: DomainEventHandler): () => void {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(handler);
    return () => this.handlers.get(name)?.delete(handler);
  }

  /** Subscribe to every event — used by extensions and the audit trail. */
  onAny(handler: DomainEventHandler): () => void {
    this.wildcards.add(handler);
    return () => this.wildcards.delete(handler);
  }

  /**
   * Persist an event and notify subscribers.
   *
   * `organizationId` and `actorId` default to the ambient request context so
   * callers in a normal request path only supply name and payload.
   */
  async publish(
    name: DomainEventName | string,
    payload: Record<string, unknown> = {},
    options: { organizationId?: string; actorId?: string; correlationId?: string } = {},
  ): Promise<DomainEventEnvelope> {
    const ctx = RequestContextStore.get();
    const organizationId = options.organizationId ?? ctx?.organizationId;

    if (!organizationId) {
      throw new Error(
        `Cannot publish "${name}": no organizationId in context or options.`,
      );
    }

    const envelope: DomainEventEnvelope = {
      name,
      organizationId,
      payload,
      actorId: options.actorId ?? ctx?.userId,
      correlationId: options.correlationId ?? ctx?.requestId,
      occurredAt: new Date(),
    };

    await this.persist(envelope);
    await this.dispatch(envelope);
    return envelope;
  }

  private async persist(envelope: DomainEventEnvelope): Promise<void> {
    const ctx = RequestContextStore.get();

    // The write is performed *as* the event's organization rather than the
    // ambient one. Registration publishes `organization.created` and
    // `user.registered` before any tenant context exists, and the repository
    // layer — correctly — refuses to write without one. Supplying the scope
    // explicitly here is what lets those events be recorded at all, and keeps
    // an event from ever landing in a different tenant than it names.
    const scope = {
      userId: envelope.actorId ?? ctx?.userId ?? '',
      organizationId: envelope.organizationId,
      roleKey: ctx?.roleKey ?? 'SYSTEM',
      permissions: ctx?.permissions ?? [],
      requestId: envelope.correlationId ?? ctx?.requestId ?? `event-${Date.now()}`,
    };

    try {
      await RequestContextStore.run(scope, () =>
        this.events.create({
          name: envelope.name,
          payload: envelope.payload as never,
          actorId: envelope.actorId ?? null,
          correlationId: envelope.correlationId ?? null,
        }),
      );
    } catch (error) {
      // A failed write must not abort the business operation that produced
      // the event, but it is a real problem — log loudly.
      this.logger.error(
        `Failed to persist event "${envelope.name}": ${(error as Error).message}`,
      );
    }
  }

  private async dispatch(envelope: DomainEventEnvelope): Promise<void> {
    const targets = [
      ...(this.handlers.get(envelope.name) ?? []),
      ...this.wildcards,
    ];

    await Promise.all(
      targets.map(async (handler) => {
        try {
          await handler(envelope);
        } catch (error) {
          this.logger.error(
            `Subscriber for "${envelope.name}" threw: ${(error as Error).message}`,
          );
        }
      }),
    );
  }

  /** Registered handler count — used by tests and the health endpoint. */
  subscriberCount(name?: string): number {
    if (name) return (this.handlers.get(name)?.size ?? 0) + this.wildcards.size;
    let total = this.wildcards.size;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }
}
