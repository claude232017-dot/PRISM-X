import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent, DomainEventEnvelope } from '../events/domain-events';

export interface NotificationChannel {
  readonly name: string;
  deliver(notification: {
    organizationId: string;
    subject: string;
    body: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Logs deliveries instead of sending them. Phase 1 has no mail or push
 * transport configured, and a channel that silently drops messages is worse
 * than one that says exactly what it would have sent.
 */
@Injectable()
export class LogNotificationChannel implements NotificationChannel {
  readonly name = 'log';
  private readonly logger = new Logger('Notification');

  async deliver(notification: {
    organizationId: string;
    subject: string;
    body: string;
  }): Promise<void> {
    this.logger.log(`[${notification.organizationId}] ${notification.subject} — ${notification.body}`);
  }
}

/**
 * Turns domain events into notifications.
 *
 * The set of notable events is declared as data so that adding a notification
 * does not mean editing a switch statement buried in a handler.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly channels: NotificationChannel[] = [];

  private static readonly NOTABLE: Record<string, (e: DomainEventEnvelope) => string> = {
    [DomainEvent.MissionCompleted]: (e) =>
      `Mission ${(e.payload as { missionId?: string }).missionId} completed.`,
    [DomainEvent.MissionFailed]: (e) =>
      `Mission ${(e.payload as { missionId?: string }).missionId} failed.`,
    [DomainEvent.ProviderFailed]: (e) =>
      `Provider ${(e.payload as { providerId?: string }).providerId} reported an error.`,
    [DomainEvent.IntegrationFailed]: (e) =>
      `Integration ${(e.payload as { integrationId?: string }).integrationId} failed.`,
    [DomainEvent.UserInvited]: (e) =>
      `${(e.payload as { email?: string }).email} was invited to the organization.`,
  };

  constructor(
    private readonly bus: EventBusService,
    private readonly logChannel: LogNotificationChannel,
  ) {}

  onModuleInit(): void {
    this.register(this.logChannel);

    for (const [eventName, format] of Object.entries(NotificationsService.NOTABLE)) {
      this.bus.on(eventName, async (event) => {
        await this.dispatch({
          organizationId: event.organizationId,
          subject: eventName,
          body: format(event),
          metadata: event.payload,
        });
      });
    }
  }

  register(channel: NotificationChannel): void {
    this.channels.push(channel);
  }

  /** Fans out to every channel; one failing channel must not block the others. */
  async dispatch(notification: {
    organizationId: string;
    subject: string;
    body: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await Promise.allSettled(this.channels.map((c) => c.deliver(notification)));
  }
}

@Module({
  providers: [NotificationsService, LogNotificationChannel],
  exports: [NotificationsService],
})
export class NotificationsModule {}
