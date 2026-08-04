import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Trigger, TriggerType } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TriggerRepository } from '../database/repositories/automation.repositories';
import { WorkflowEngine } from '../workflows/workflow-engine.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent, DomainEventEnvelope } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { evaluateCondition } from '../workflows/workflow-engine.service';
import { resolveTemplate } from '../integrations/connectors/http-connector';
import type { WorkflowCondition } from '../workflows/execution/execution-adapter.contract';

/**
 * Turns things that happen into workflow runs.
 *
 * Three sources, one path: every trigger resolves an organization, evaluates
 * its condition, maps the payload onto workflow inputs, and starts a run.
 *
 *  - **Internal** — any domain event on the bus.
 *  - **External** — an inbound webhook at an unguessable path, optionally
 *    HMAC-verified.
 *  - **Scheduled** — cron or fixed interval, evaluated by a ticker.
 *
 * Because triggers run outside any HTTP request, each one establishes its own
 * RequestContext before touching the repository layer — which otherwise (and
 * correctly) refuses to run unscoped.
 */
@Injectable()
export class TriggerEngine implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriggerEngine.name);
  private ticker: NodeJS.Timeout | null = null;

  /** How often schedules are evaluated. */
  private static readonly TICK_MS = 30_000;

  constructor(
    private readonly triggers: TriggerRepository,
    private readonly workflows: WorkflowEngine,
    private readonly events: EventBusService,
  ) {}

  /**
   * Guard supplied by the production layer once several instances can run at
   * once. A callback rather than an injected service because this module sits
   * below the production module and must keep working without it — when unset,
   * the tick runs, which is correct for a single instance and is exactly what
   * this module did before the guard existed.
   */
  private shouldTick: () => boolean = () => true;

  onScheduleGuard(guard: () => boolean): void {
    this.shouldTick = guard;
  }

  onModuleInit(): void {
    // One wildcard subscription covers every event trigger, rather than
    // re-subscribing whenever a trigger is created.
    this.events.onAny((event) => this.onDomainEvent(event));

    this.ticker = setInterval(() => {
      // Scheduled work is cluster-wide, not per instance. Without this, three
      // instances fire every schedule three times — and nothing errors, the
      // work simply happens repeatedly, which is the hardest kind of bug to
      // notice from outside.
      if (!this.shouldTick()) return;

      void this.tickSchedules().catch((error) =>
        this.logger.error(`Schedule tick failed: ${(error as Error).message}`),
      );
    }, TriggerEngine.TICK_MS);
    // Do not hold the process open for the ticker alone.
    this.ticker.unref?.();

    this.logger.log(`Trigger engine started (schedule tick ${TriggerEngine.TICK_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  // ----------------------------------------------------------------
  // Internal: domain events
  // ----------------------------------------------------------------

  private async onDomainEvent(event: DomainEventEnvelope): Promise<void> {
    // Workflow events would let a workflow trigger itself indefinitely.
    if (event.name.startsWith('workflow.') || event.name.startsWith('trigger.')) return;

    try {
      await this.asOrganization(event.organizationId, async () => {
        const matches = await this.triggers.findByEvent(event.name);
        for (const trigger of matches) {
          await this.fire(trigger, event.payload as Record<string, unknown>, 'event');
        }
      });
    } catch (error) {
      this.logger.error(
        `Event trigger dispatch failed for "${event.name}": ${(error as Error).message}`,
      );
    }
  }

  // ----------------------------------------------------------------
  // External: inbound webhooks
  // ----------------------------------------------------------------

  /**
   * Handles an inbound webhook.
   *
   * The path resolves the organization, because the request itself carries no
   * authentication. That is why paths are random and long: the path *is* the
   * capability, and an optional HMAC signature layers proof of origin on top.
   */
  async handleWebhook(
    path: string,
    payload: Record<string, unknown>,
    options: { signature?: string; rawBody?: string } = {},
  ): Promise<{ accepted: boolean; runId?: string; reason?: string }> {
    const trigger = await this.triggers.findByWebhookPathUnscoped(path);
    if (!trigger) return { accepted: false, reason: 'Unknown webhook path' };

    if (trigger.webhookSecret) {
      const verified = TriggerEngine.verifySignature(
        trigger.webhookSecret,
        options.rawBody ?? JSON.stringify(payload),
        options.signature,
      );
      if (!verified) {
        await this.recordFailure(trigger, 'Invalid signature');
        return { accepted: false, reason: 'Invalid signature' };
      }
    }

    return this.asOrganization(trigger.organizationId, async () => {
      await this.events.publish(
        DomainEvent.WebhookReceived,
        { triggerId: trigger.id, path },
        { organizationId: trigger.organizationId },
      );
      const result = await this.fire(trigger, payload, 'webhook');
      return result.fired
        ? { accepted: true, runId: result.runId }
        : { accepted: false, reason: result.reason };
    });
  }

  /**
   * Constant-time HMAC-SHA256 comparison.
   *
   * Accepts a bare hex digest or the common `sha256=` prefix.
   */
  static verifySignature(secret: string, body: string, signature?: string): boolean {
    if (!signature) return false;

    const expected = createHmac('sha256', secret).update(body).digest('hex');
    const provided = signature.replace(/^sha256=/i, '').trim();

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  static generateWebhookPath(): string {
    return randomBytes(24).toString('base64url');
  }

  static generateWebhookSecret(): string {
    return randomBytes(32).toString('hex');
  }

  // ----------------------------------------------------------------
  // Scheduled
  // ----------------------------------------------------------------

  /** Fires every schedule whose next run time has passed. */
  async tickSchedules(): Promise<number> {
    const due = await this.dueSchedulesUnscoped();
    let fired = 0;

    for (const trigger of due) {
      try {
        await this.asOrganization(trigger.organizationId, async () => {
          const result = await this.fire(trigger, { firedAt: new Date().toISOString() }, 'schedule');
          if (result.fired) fired++;
          await this.triggers.update(trigger.id, {
            nextRunAt: TriggerEngine.nextRun(trigger),
          });
        });
      } catch (error) {
        this.logger.error(
          `Schedule "${trigger.name}" failed: ${(error as Error).message}`,
        );
      }
    }

    return fired;
  }

  /** Due schedules across every organization, via the repository layer. */
  private dueSchedulesUnscoped(): Promise<Trigger[]> {
    return this.triggers.findDueSchedulesUnscoped(100);
  }

  /**
   * Computes the next fire time.
   *
   * Interval triggers are exact. Cron support is deliberately limited to the
   * common shapes: each field may be a wildcard, a number, a list, a range,
   * or a step expression — enough
   * for hourly/daily/weekly/monthly schedules without taking on a full cron
   * parser. An unparseable expression falls back to hourly rather than never
   * firing, so a typo degrades instead of silently disabling automation.
   */
  static nextRun(trigger: Pick<Trigger, 'cron' | 'intervalSeconds'>, from = new Date()): Date {
    if (trigger.intervalSeconds && trigger.intervalSeconds > 0) {
      return new Date(from.getTime() + trigger.intervalSeconds * 1000);
    }
    if (!trigger.cron) return new Date(from.getTime() + 3_600_000);

    const parts = trigger.cron.trim().split(/\s+/);
    if (parts.length !== 5) return new Date(from.getTime() + 3_600_000);

    const [minute, hour, dayOfMonth, , dayOfWeek] = parts;

    // Step through minutes until every field matches. Bounded to ~1 year so a
    // schedule that can never match cannot spin.
    const candidate = new Date(from.getTime());
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    for (let i = 0; i < 527_040; i++) {
      if (
        matchesField(minute, candidate.getUTCMinutes()) &&
        matchesField(hour, candidate.getUTCHours()) &&
        matchesField(dayOfMonth, candidate.getUTCDate()) &&
        matchesField(dayOfWeek, candidate.getUTCDay())
      ) {
        return candidate;
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }

    return new Date(from.getTime() + 3_600_000);
  }

  // ----------------------------------------------------------------
  // Firing
  // ----------------------------------------------------------------

  /** Evaluates a trigger's condition and starts its workflow. */
  async fire(
    trigger: Trigger,
    payload: Record<string, unknown>,
    source: string,
  ): Promise<{ fired: boolean; runId?: string; reason?: string }> {
    const conditions = (trigger.conditions ?? {}) as WorkflowCondition | Record<string, never>;

    if (Object.keys(conditions).length > 0) {
      const passes = evaluateCondition(conditions as WorkflowCondition, {
        input: payload,
        context: {},
      });
      if (!passes) {
        return { fired: false, reason: 'Trigger condition not met' };
      }
    }

    const mapping = (trigger.inputMapping ?? {}) as Record<string, unknown>;
    const input = Object.keys(mapping).length
      ? resolveTemplate(mapping, { ...payload, payload })
      : payload;

    try {
      const run = await this.workflows.start({
        workflowId: trigger.workflowId,
        input,
        triggerType: trigger.type,
        triggerId: trigger.id,
      });

      await this.triggers.update(trigger.id, {
        lastFiredAt: new Date(),
        fireCount: trigger.fireCount + 1,
      });

      await this.events.publish(
        DomainEvent.TriggerFired,
        {
          triggerId: trigger.id,
          name: trigger.name,
          source,
          workflowId: trigger.workflowId,
          runId: run.runId,
        },
        { organizationId: trigger.organizationId },
      );

      return { fired: true, runId: run.runId };
    } catch (error) {
      await this.recordFailure(trigger, (error as Error).message);
      return { fired: false, reason: (error as Error).message };
    }
  }

  private async recordFailure(trigger: Trigger, reason: string): Promise<void> {
    try {
      await this.asOrganization(trigger.organizationId, async () => {
        await this.triggers.update(trigger.id, { failCount: trigger.failCount + 1 });
        await this.events.publish(
          DomainEvent.TriggerFailed,
          { triggerId: trigger.id, reason: reason.slice(0, 300) },
          { organizationId: trigger.organizationId },
        );
      });
    } catch (error) {
      this.logger.error(`Could not record trigger failure: ${(error as Error).message}`);
    }
  }

  /**
   * Runs `fn` inside an organization's context.
   *
   * Triggers fire outside any HTTP request, so there is no ambient context to
   * inherit — and the repository layer refuses to run without one, which is
   * exactly the protection that must not be bypassed here.
   */
  private asOrganization<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return RequestContextStore.run(
      {
        userId: 'system',
        organizationId,
        roleKey: 'SYSTEM',
        permissions: ['*'],
        requestId: `trigger-${Date.now()}`,
      },
      fn,
    );
  }
}

/**
 * Matches one cron field against a value.
 *
 * Supports a wildcard, a plain number, a comma list, an inclusive range, and
 * a step expression (slash-n).
 */
function matchesField(field: string, value: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    if (part.startsWith('*/')) {
      const step = Number(part.slice(2));
      if (Number.isFinite(step) && step > 0 && value % step === 0) return true;
      continue;
    }
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end) {
        return true;
      }
      continue;
    }
    if (Number(part) === value) return true;
  }

  return false;
}
