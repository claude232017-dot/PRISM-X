import { Injectable, Logger } from '@nestjs/common';
import { Notification, NotificationSeverity } from '@prisma/client';
import { NotificationRepository } from '../database/repositories/automation.repositories';
import { IntegrationRepository } from '../database/repositories/tenant.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';

export interface SendNotificationInput {
  category: string;
  subject: string;
  body: string;
  severity?: NotificationSeverity | string;
  userId?: string;
  metadata?: Record<string, unknown>;
  /** Channels to attempt. Defaults to in-app plus any configured routes. */
  channels?: string[];
  organizationId?: string;
}

export interface ChannelDelivery {
  channel: string;
  ok: boolean;
  error?: string;
  at: string;
}

/**
 * One place every notification passes through.
 *
 * In-app delivery is the floor: a notification is *always* persisted, so
 * nothing is lost because Slack was down or no channel was configured. External
 * channels are attempted on top and their per-channel outcome is recorded on
 * the row, which means a failed delivery is visible rather than invisible.
 *
 * External channels are delivered through the Integration Manager rather than
 * bespoke HTTP calls here, so they inherit its retries, circuit breaking and
 * usage accounting.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  /**
   * Registered late to avoid a circular dependency: the Integration Manager
   * depends on the event bus, which the notification service also uses.
   */
  private deliverExternal:
    | ((integrationId: string, action: string, input: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>)
    | null = null;

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly integrations: IntegrationRepository,
    private readonly events: EventBusService,
  ) {}

  onExternalDelivery(
    handler: (
      integrationId: string,
      action: string,
      input: Record<string, unknown>,
    ) => Promise<{ ok: boolean; error?: string }>,
  ): void {
    this.deliverExternal = handler;
  }

  async send(input: SendNotificationInput): Promise<Notification> {
    const ctx = RequestContextStore.get();
    const organizationId = input.organizationId ?? ctx?.organizationId;

    if (!organizationId) {
      throw new Error(`Cannot send "${input.subject}": no organization in scope`);
    }

    const deliveries: ChannelDelivery[] = [
      // In-app is satisfied by the row itself existing.
      { channel: 'in_app', ok: true, at: new Date().toISOString() },
    ];

    const externalChannels = input.channels ?? (await this.routesFor(input.category));
    for (const channel of externalChannels) {
      if (channel === 'in_app') continue;
      deliveries.push(await this.attempt(channel, input));
    }

    const notification = await this.notifications.create({
      userId: input.userId ?? null,
      category: input.category,
      severity: (input.severity as NotificationSeverity) ?? NotificationSeverity.INFO,
      subject: input.subject,
      body: input.body,
      deliveries: deliveries as never,
      metadata: (input.metadata ?? {}) as never,
    });

    await this.events.publish(
      DomainEvent.NotificationSent,
      {
        notificationId: notification.id,
        category: input.category,
        severity: notification.severity,
        channels: deliveries.map((d) => d.channel),
        failed: deliveries.filter((d) => !d.ok).map((d) => d.channel),
      },
      { organizationId },
    );

    return notification;
  }

  /**
   * Resolves which external channels a category routes to.
   *
   * An integration opts in by declaring `config.notificationCategories`. An
   * empty declaration means "all categories", so wiring up Slack once is
   * enough to start receiving everything.
   */
  private async routesFor(category: string): Promise<string[]> {
    try {
      const active = await this.integrations.findMany({ status: 'ACTIVE' }, { take: 50 });
      return active
        .filter((integration) => {
          const config = (integration.config ?? {}) as {
            notifications?: boolean;
            notificationCategories?: string[];
          };
          if (!config.notifications) return false;
          const categories = config.notificationCategories ?? [];
          return categories.length === 0 || categories.includes(category);
        })
        .map((integration) => `integration:${integration.id}`);
    } catch (error) {
      this.logger.warn(`Could not resolve notification routes: ${(error as Error).message}`);
      return [];
    }
  }

  private async attempt(
    channel: string,
    input: SendNotificationInput,
  ): Promise<ChannelDelivery> {
    const at = new Date().toISOString();

    if (channel.startsWith('integration:')) {
      const integrationId = channel.slice('integration:'.length);
      if (!this.deliverExternal) {
        return { channel, ok: false, error: 'External delivery is not wired', at };
      }
      try {
        const result = await this.deliverExternal(integrationId, 'send', {
          to: input.userId ?? 'organization',
          message: `${input.subject}\n\n${input.body}`,
          text: `${input.subject}\n\n${input.body}`,
          channel: input.category,
        });
        return { channel, ok: result.ok, error: result.error, at };
      } catch (error) {
        // A failing channel must never prevent the notification being recorded.
        return { channel, ok: false, error: (error as Error).message, at };
      }
    }

    // Channels with no transport configured are recorded honestly as
    // undelivered rather than silently reported as sent.
    this.logger.debug(`[${channel}] ${input.subject} — ${input.body.slice(0, 120)}`);
    return {
      channel,
      ok: false,
      error: `No transport configured for "${channel}"; recorded in-app only`,
      at,
    };
  }

  list(unreadOnly = false): Promise<Notification[]> {
    return unreadOnly
      ? this.notifications.findUnread()
      : this.notifications.findMany({}, { take: 100, orderBy: { createdAt: 'desc' } });
  }

  markRead(id: string): Promise<Notification> {
    return this.notifications.update(id, { readAt: new Date() });
  }

  markAllRead(): Promise<number> {
    return this.notifications.markAllRead();
  }

  async statistics() {
    const [total, unread] = await Promise.all([
      this.notifications.count(),
      this.notifications.count({ readAt: null }),
    ]);
    return { total, unread, read: total - unread };
  }
}
