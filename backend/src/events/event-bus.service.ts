import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DomainEventEnvelope,
  DomainEventHandler,
  DomainEventName,
} from './domain-events';
import { EventRepository } from '../database/repositories/tenant.repositories';
import { RequestContextStore } from '../shared/context/request-context';

/**
 * How deep a chain of events may go before the bus stops dispatching.
 *
 * A subscriber may publish. That subscriber's event has subscribers, which may
 * publish. The design is deliberate — a trigger fires a workflow, the workflow
 * starts a mission, the mission emits progress — but nothing in it is bounded.
 * One badly written extension that republishes an event it also listens for
 * produces infinite recursion inside a single HTTP request, and the first
 * symptom is a stack overflow or a wedged worker, not a helpful error.
 *
 * Eight is deeper than any legitimate chain in the platform (the longest real
 * one is trigger → workflow → mission → task → execution, five) and shallow
 * enough that a loop is caught in milliseconds.
 */
export const MAX_CASCADE_DEPTH = 8;

/**
 * How long one subscriber may take before the bus stops waiting for it.
 *
 * Subscribers are awaited so that ordering is preserved and a caller can rely
 * on "publish returned, listeners ran". The cost of awaiting is that one slow
 * listener holds the publisher — and therefore the request — open. The timeout
 * puts a ceiling on that: the listener keeps running, but nobody is blocked on
 * it any more.
 */
export const SUBSCRIBER_TIMEOUT_MS = 10_000;

/** Ambient cascade depth, carried across the async boundaries of a dispatch. */
const cascade = new AsyncLocalStorage<number>();

/**
 * In-process publish/subscribe with durable persistence.
 *
 * Four properties matter here:
 *
 *  - **Publishing never breaks the publisher.** A throwing subscriber is
 *    logged and swallowed. Creating a worker must not fail because an
 *    analytics listener has a bug.
 *  - **Every event is written to the `events` table,** so a subscriber added
 *    later can replay history, and so the audit trail does not depend on any
 *    listener being registered at the time. The write is batched — see
 *    `AppendBuffer` — and any read of the table drains the batch first.
 *  - **The cascade is bounded.** An event published from inside a subscriber
 *    is one level deeper, and past `MAX_CASCADE_DEPTH` the bus persists the
 *    event but refuses to dispatch it. A runaway chain stops with a loud log
 *    and a counter instead of exhausting the stack.
 *  - **A subscriber cannot hold the publisher forever.** Each one is raced
 *    against `SUBSCRIBER_TIMEOUT_MS`.
 *
 * Cross-process fan-out (BullMQ / Supabase Realtime) plugs in behind the same
 * `publish` call in a later phase without touching callers.
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);
  private readonly handlers = new Map<string, Set<DomainEventHandler>>();
  private readonly wildcards = new Set<DomainEventHandler>();

  /** Events refused for exceeding the cascade depth, by event name. */
  private readonly refused = new Map<string, number>();

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

    const depth = cascade.getStore() ?? 0;
    if (depth >= MAX_CASCADE_DEPTH) {
      // Persisted but not dispatched. The record of what happened survives —
      // which is what makes the loop diagnosable — while the chain stops.
      this.refused.set(name, (this.refused.get(name) ?? 0) + 1);
      this.logger.error(
        `Cascade depth ${depth} reached on "${name}" — not dispatching. ` +
          'A subscriber is publishing an event that leads back to itself.',
      );
      return envelope;
    }

    await cascade.run(depth + 1, () => this.dispatch(envelope));
    return envelope;
  }

  /** Events refused for depth, for the metrics gauge and the health view. */
  refusedCascades(): Record<string, number> {
    return Object.fromEntries(this.refused);
  }

  /** Rows still buffered for the events table. */
  pendingWrites(): number {
    return this.events.pending;
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
        this.events.append({
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
          await EventBusService.withTimeout(
            Promise.resolve(handler(envelope)),
            envelope.name,
          );
        } catch (error) {
          this.logger.error(
            `Subscriber for "${envelope.name}" threw: ${(error as Error).message}`,
          );
        }
      }),
    );
  }

  /**
   * Stops waiting on a subscriber that has taken too long.
   *
   * The handler is not cancelled — it cannot be — but the publisher stops
   * being held by it, which is the part that turns one slow listener into a
   * pile of stuck requests.
   */
  private static withTimeout(work: Promise<unknown>, name: string): Promise<unknown> {
    let timer: NodeJS.Timeout;
    const ceiling = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `still running after ${SUBSCRIBER_TIMEOUT_MS}ms; no longer waiting on it`,
            ),
          ),
        SUBSCRIBER_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    void name;
    return Promise.race([work, ceiling]).finally(() => clearTimeout(timer));
  }

  /** Registered handler count — used by tests and the health endpoint. */
  subscriberCount(name?: string): number {
    if (name) return (this.handlers.get(name)?.size ?? 0) + this.wildcards.size;
    let total = this.wildcards.size;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }
}
