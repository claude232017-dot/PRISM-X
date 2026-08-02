import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WebhookEndpoint } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DeadLetterRepository,
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
} from '../database/repositories/automation.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent, DomainEventEnvelope } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';

/**
 * Outbound webhooks.
 *
 * Every domain event is offered to endpoints subscribed to it. Deliveries are
 * signed, retried with exponential backoff, and — once retries are exhausted —
 * dead-lettered rather than dropped.
 *
 * A persistently failing endpoint is disabled after a streak of failures. A
 * dead URL that keeps consuming delivery capacity degrades the service for
 * every other subscriber, so removing it is the correct behaviour rather than
 * a discourtesy.
 */
@Injectable()
export class WebhookDispatcher implements OnModuleInit {
  private readonly logger = new Logger(WebhookDispatcher.name);

  private static readonly MAX_STREAK = 10;
  private static readonly TIMEOUT_MS = 15_000;

  constructor(
    private readonly endpoints: WebhookEndpointRepository,
    private readonly deliveries: WebhookDeliveryRepository,
    private readonly deadLetters: DeadLetterRepository,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void {
    this.events.onAny((event) => this.onDomainEvent(event));
    this.logger.log('Outbound webhook dispatcher subscribed to the event bus');
  }

  private async onDomainEvent(event: DomainEventEnvelope): Promise<void> {
    // Webhook lifecycle events would feed themselves.
    if (event.name.startsWith('webhook.')) return;

    try {
      await RequestContextStore.run(
        {
          userId: 'system',
          organizationId: event.organizationId,
          roleKey: 'SYSTEM',
          permissions: ['*'],
          requestId: `webhook-${Date.now()}`,
        },
        async () => {
          const subscribers = await this.endpoints.findSubscribers(event.name);
          for (const endpoint of subscribers) {
            await this.enqueue(endpoint, event);
          }
        },
      );
    } catch (error) {
      this.logger.error(`Webhook fan-out failed: ${(error as Error).message}`);
    }
  }

  private async enqueue(
    endpoint: WebhookEndpoint,
    event: DomainEventEnvelope,
  ): Promise<void> {
    const delivery = await this.deliveries.create({
      endpointId: endpoint.id,
      eventName: event.name,
      payload: {
        event: event.name,
        occurredAt: event.occurredAt,
        correlationId: event.correlationId,
        data: event.payload,
      } as never,
    });

    // Attempted inline; failures fall through to the retry sweep.
    await this.attempt(delivery.id).catch((error) =>
      this.logger.warn(`Initial delivery failed: ${(error as Error).message}`),
    );
  }

  /** Attempts one delivery, scheduling a retry or dead-lettering as needed. */
  async attempt(deliveryId: string): Promise<boolean> {
    const delivery = await this.deliveries.findByIdOrFail(deliveryId);
    const endpoint = await this.endpoints.findByIdOrFail(delivery.endpointId);

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = WebhookDispatcher.sign(endpoint.secret, timestamp, body);
    const attempt = delivery.attempts + 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WebhookDispatcher.TIMEOUT_MS);

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-prismx-event': delivery.eventName,
          'x-prismx-delivery': delivery.id,
          'x-prismx-timestamp': String(timestamp),
          // `t=<ts>,v1=<hmac>` — the timestamp is signed too, so a captured
          // delivery cannot be replayed indefinitely.
          'x-prismx-signature': signature,
        },
        body,
        signal: controller.signal,
      });

      const text = await response.text();

      if (response.ok) {
        await this.deliveries.update(deliveryId, {
          status: 'DELIVERED',
          attempts: attempt,
          responseStatus: response.status,
          responseBody: text.slice(0, 1000),
          deliveredAt: new Date(),
          nextAttemptAt: null,
          error: null,
        });
        await this.endpoints.update(endpoint.id, {
          failureStreak: 0,
          lastSuccessAt: new Date(),
        });
        await this.events.publish(DomainEvent.WebhookDelivered, {
          deliveryId,
          endpointId: endpoint.id,
          event: delivery.eventName,
          attempts: attempt,
        });
        return true;
      }

      await this.recordFailure(
        deliveryId,
        endpoint,
        attempt,
        `HTTP ${response.status}: ${text.slice(0, 200)}`,
        response.status,
      );
      return false;
    } catch (error) {
      await this.recordFailure(
        deliveryId,
        endpoint,
        attempt,
        (error as Error).message,
        undefined,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async recordFailure(
    deliveryId: string,
    endpoint: WebhookEndpoint,
    attempt: number,
    error: string,
    responseStatus?: number,
  ): Promise<void> {
    const exhausted = attempt >= endpoint.maxRetries;

    await this.deliveries.update(deliveryId, {
      status: exhausted ? 'EXHAUSTED' : 'FAILED',
      attempts: attempt,
      error: error.slice(0, 500),
      responseStatus: responseStatus ?? null,
      // Exponential backoff, capped so a long outage does not push the next
      // attempt beyond usefulness.
      nextAttemptAt: exhausted
        ? null
        : new Date(Date.now() + Math.min(2 ** attempt * 1000, 300_000)),
    });

    const streak = endpoint.failureStreak + 1;
    await this.endpoints.update(endpoint.id, {
      failureStreak: streak,
      lastFailureAt: new Date(),
      ...(streak >= WebhookDispatcher.MAX_STREAK ? { enabled: false } : {}),
    });

    if (streak >= WebhookDispatcher.MAX_STREAK) {
      this.logger.error(
        `Webhook endpoint "${endpoint.name}" disabled after ${streak} consecutive failures`,
      );
    }

    if (exhausted) {
      const delivery = await this.deliveries.findByIdOrFail(deliveryId);
      await this.deadLetters.create({
        source: 'webhook_delivery',
        reference: deliveryId,
        reason: error.slice(0, 500),
        payload: delivery.payload as never,
        attempts: attempt,
      });
      await this.events.publish(DomainEvent.DeadLetterRecorded, {
        source: 'webhook_delivery',
        reference: deliveryId,
      });
    }

    await this.events.publish(DomainEvent.WebhookDeliveryFailed, {
      deliveryId,
      endpointId: endpoint.id,
      attempt,
      exhausted,
      error: error.slice(0, 200),
    });
  }

  /** Retries every delivery whose backoff has elapsed. */
  async retryPending(): Promise<number> {
    const due = await this.deliveries.findRetryable();
    let delivered = 0;
    for (const delivery of due) {
      if (await this.attempt(delivery.id)) delivered++;
    }
    return delivered;
  }

  /** `t=<timestamp>,v1=<hmac>` over `<timestamp>.<body>`. */
  static sign(secret: string, timestamp: number, body: string): string {
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `t=${timestamp},v1=${digest}`;
  }

  /**
   * Verifies a signature produced by `sign`, for receivers written against
   * this API. Rejects anything older than `toleranceSeconds` so a captured
   * request cannot be replayed later.
   */
  static verify(
    secret: string,
    header: string,
    body: string,
    toleranceSeconds = 300,
  ): boolean {
    const parts = Object.fromEntries(
      header.split(',').map((p) => p.split('=').map((s) => s.trim()) as [string, string]),
    );
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) return false;
    if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1 ?? '');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  static generateSecret(): string {
    return randomBytes(32).toString('hex');
  }

  async statistics() {
    const [total, delivered, failed, exhausted] = await Promise.all([
      this.deliveries.count(),
      this.deliveries.count({ status: 'DELIVERED' }),
      this.deliveries.count({ status: 'FAILED' }),
      this.deliveries.count({ status: 'EXHAUSTED' }),
    ]);
    const finished = delivered + exhausted;
    return {
      total,
      delivered,
      pendingRetry: failed,
      exhausted,
      deliveryRate: finished > 0 ? Math.round((delivered / finished) * 100) : null,
    };
  }
}
