import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Invoice, Plan, Subscription } from '@prisma/client';
import {
  InvoiceRepository,
  PlanRepository,
  SubscriptionRepository,
} from '../database/repositories/production.repositories';
import { UsageDailyRepository } from '../database/repositories/execution.repositories';
import { MembershipRepository } from '../database/repositories/identity.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';

/**
 * Billing, licensing and feature gating.
 *
 * The brief says billing must stay modular and optional, and that shapes every
 * decision here:
 *
 * **No payment processor is wired in.** Nothing in this service talks to
 * Stripe or anyone else. It computes what is owed and records it; `externalRef`
 * is where a processor's identifier goes when one is connected. Charging money
 * is an integration, and integrating it should not require rewriting how the
 * amount is worked out.
 *
 * **An organization with no subscription is not blocked.** `entitlements`
 * falls back to a permissive default, so a deployment that never touches
 * billing behaves exactly as it did before Phase 8. Gating is something an
 * operator turns on, not something they have to turn off.
 *
 * **Usage is read, never written.** AI spend already lands in `UsageDaily`
 * during execution. Billing sums what execution recorded rather than keeping a
 * second counter, because two counters eventually disagree and the one the
 * customer sees is the one they dispute.
 */
@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger(BillingService.name);

  /** What an organization gets when billing has never been configured. */
  private static readonly UNLICENSED = Object.freeze({
    planKey: 'unlicensed',
    planName: 'Unlicensed',
    status: 'ACTIVE',
    seats: Number.MAX_SAFE_INTEGER,
    features: ['*'],
    limits: {} as Record<string, number>,
    includedKTokens: Number.MAX_SAFE_INTEGER,
  });

  constructor(
    private readonly plans: PlanRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly invoices: InvoiceRepository,
    private readonly usage: UsageDailyRepository,
    private readonly memberships: MembershipRepository,
    private readonly events: EventBusService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedPlans();
  }

  /**
   * The shipped plan ladder. Upserted by key so an operator's pricing survives
   * a restart, and only created when absent.
   */
  private async seedPlans(): Promise<void> {
    const catalogue = [
      {
        key: 'free',
        name: 'Free',
        description: 'For trying PRISM-X on real work.',
        priceCents: 0,
        seatsIncluded: 1,
        seatPriceCents: 0,
        features: ['missions', 'workers', 'knowledge'],
        limits: { missionsPerMonth: 50, workers: 3, nodes: 1, extensions: 2 },
        includedKTokens: 100,
        aiOveragePerKTokenCents: 0,
        trialDays: 0,
        sortOrder: 1,
      },
      {
        key: 'team',
        name: 'Team',
        description: 'Automation, integrations and a shared knowledge base.',
        priceCents: 9900,
        seatsIncluded: 5,
        seatPriceCents: 1900,
        features: ['missions', 'workers', 'knowledge', 'workflows', 'integrations', 'extensions', 'analytics'],
        limits: { missionsPerMonth: 2000, workers: 25, nodes: 5, extensions: 20 },
        includedKTokens: 5_000,
        aiOveragePerKTokenCents: 0.4,
        trialDays: 14,
        sortOrder: 2,
      },
      {
        key: 'business',
        name: 'Business',
        description: 'Distributed execution, learning and evolution.',
        priceCents: 49900,
        seatsIncluded: 25,
        seatPriceCents: 1500,
        features: [
          'missions', 'workers', 'knowledge', 'workflows', 'integrations', 'extensions',
          'analytics', 'distributed', 'learning', 'evolution', 'marketplace',
        ],
        limits: { missionsPerMonth: 25_000, workers: 200, nodes: 50, extensions: 100 },
        includedKTokens: 50_000,
        aiOveragePerKTokenCents: 0.3,
        trialDays: 14,
        sortOrder: 3,
      },
      {
        key: 'enterprise',
        name: 'Enterprise',
        description: 'Everything, with governance, compliance and support.',
        priceCents: 0, // Negotiated. Zero here means "talk to us", not "free".
        seatsIncluded: 100,
        seatPriceCents: 0,
        features: ['*'],
        limits: {},
        includedKTokens: 500_000,
        aiOveragePerKTokenCents: 0.2,
        trialDays: 30,
        sortOrder: 4,
      },
    ];

    for (const plan of catalogue) {
      if (await this.plans.find(plan.key)) continue;
      await this.plans.upsert(plan.key, plan as never);
    }
  }

  // ============================================================ plans

  listPlans(includeHidden = false): Promise<Plan[]> {
    return this.plans.list(includeHidden);
  }

  // ============================================================ subscription

  /** Starts or changes a subscription. A trial is a status, not a plan. */
  async subscribe(input: { planKey: string; seats?: number; startTrial?: boolean }): Promise<Subscription> {
    const plan = await this.plans.findOrFail(input.planKey);
    const existing = await this.subscriptions.current();
    const seats = Math.max(1, input.seats ?? plan.seatsIncluded);

    const members = await this.memberships.listByOrganization(
      RequestContextStore.require().organizationId,
    );
    if (members.length > seats) {
      throw new BadRequestException(
        `This organization has ${members.length} member(s); at least that many seats are required`,
      );
    }

    const trialing = input.startTrial !== false && plan.trialDays > 0 && !existing;
    const now = new Date();
    const periodEnd = new Date(
      now.getTime() +
        (trialing ? plan.trialDays * 86_400_000 : BillingService.periodMs(plan.interval)),
    );

    const data = {
      planKey: plan.key,
      status: trialing ? 'TRIALING' : 'ACTIVE',
      seats,
      trialEndsAt: trialing ? periodEnd : null,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
    };

    const subscription = existing
      ? await this.subscriptions.update(existing.id, data)
      : await this.subscriptions.create(data);

    await this.events.publish(DomainEvent.SubscriptionChanged, {
      planKey: plan.key,
      status: data.status,
      seats,
    });
    return subscription;
  }

  private static periodMs(interval: Plan['interval']): number {
    return interval === 'ANNUAL' ? 365 * 86_400_000 : 30 * 86_400_000;
  }

  /**
   * Cancels at the end of the period rather than immediately.
   *
   * A customer who has paid through the month keeps the month. Cutting access
   * the moment they click cancel is the behaviour that generates chargebacks.
   */
  async cancel(immediately = false): Promise<Subscription> {
    const subscription = await this.requireSubscription();
    return this.subscriptions.update(subscription.id, {
      cancelAtPeriodEnd: !immediately,
      ...(immediately ? { status: 'CANCELLED', cancelledAt: new Date() } : {}),
    });
  }

  async changeSeats(seats: number): Promise<Subscription> {
    const subscription = await this.requireSubscription();
    const members = await this.memberships.listByOrganization(
      RequestContextStore.require().organizationId,
    );
    if (seats < members.length) {
      throw new BadRequestException(
        `Cannot reduce to ${seats} seat(s); the organization has ${members.length} member(s)`,
      );
    }
    return this.subscriptions.update(subscription.id, { seats: Math.max(1, seats) });
  }

  private async requireSubscription(): Promise<Subscription> {
    const subscription = await this.subscriptions.current();
    if (!subscription) throw new BadRequestException('This organization has no subscription');
    return subscription;
  }

  // ============================================================ entitlements

  /**
   * What this organization may do right now.
   *
   * The permissive fallback is deliberate: PRISM-X must run identically with
   * billing switched off, so an unsubscribed organization is unlicensed rather
   * than restricted. An expired or cancelled subscription *is* restricted,
   * because that is a decision someone made rather than a feature nobody
   * turned on.
   */
  async entitlements(): Promise<{
    planKey: string;
    planName: string;
    status: string;
    seats: number;
    seatsUsed: number;
    features: string[];
    limits: Record<string, number>;
    includedKTokens: number;
    trialEndsAt: Date | null;
    licensed: boolean;
  }> {
    const subscription = await this.subscriptions.current();
    const members = await this.memberships.listByOrganization(
      RequestContextStore.require().organizationId,
    );

    if (!subscription) {
      return {
        ...BillingService.UNLICENSED,
        features: [...BillingService.UNLICENSED.features],
        limits: { ...BillingService.UNLICENSED.limits },
        seatsUsed: members.length,
        trialEndsAt: null,
        licensed: false,
      };
    }

    const plan = await this.plans.findOrFail(subscription.planKey);
    const lapsed = ['CANCELLED', 'EXPIRED'].includes(subscription.status);

    return {
      planKey: plan.key,
      planName: plan.name,
      status: subscription.status,
      seats: subscription.seats,
      seatsUsed: members.length,
      // A lapsed subscription keeps its plan on the record but grants nothing.
      features: lapsed ? [] : plan.features,
      limits: (plan.limits ?? {}) as Record<string, number>,
      includedKTokens: plan.includedKTokens,
      trialEndsAt: subscription.trialEndsAt,
      licensed: true,
    };
  }

  /** True when a feature is available. `*` in the plan means everything. */
  async hasFeature(feature: string): Promise<boolean> {
    const { features } = await this.entitlements();
    return features.includes('*') || features.includes(feature);
  }

  /** Throws when a feature is not on the plan. The gate itself. */
  async requireFeature(feature: string): Promise<void> {
    if (await this.hasFeature(feature)) return;
    const { planName } = await this.entitlements();
    throw new ForbiddenException(`"${feature}" is not included in the ${planName} plan`);
  }

  /** Whether a countable resource is still within its ceiling. */
  async withinLimit(limit: string, current: number): Promise<{ allowed: boolean; ceiling: number | null }> {
    const { limits } = await this.entitlements();
    const ceiling = limits[limit];
    if (ceiling === undefined) return { allowed: true, ceiling: null };
    if (current >= ceiling) {
      await this.events.publish(DomainEvent.UsageLimitReached, { limit, current, ceiling });
    }
    return { allowed: current < ceiling, ceiling };
  }

  /** Refuses a seat the plan does not cover, rather than billing for it silently. */
  async assertSeatAvailable(): Promise<void> {
    const { seats, seatsUsed, licensed } = await this.entitlements();
    if (!licensed) return;
    if (seatsUsed >= seats) {
      throw new ForbiddenException(
        `All ${seats} seat(s) are in use. Add seats before inviting another member.`,
      );
    }
  }

  // ============================================================ usage

  /** AI usage for a period, read from what execution already recorded. */
  async usageForPeriod(from: Date, to: Date): Promise<{
    tokens: number;
    requests: number;
    costUsd: number;
    kTokens: number;
    byDay: Array<{ day: string; tokens: number; costUsd: number }>;
  }> {
    const rows = await this.usage.findRange(from, to);

    const byDay = new Map<string, { tokens: number; costUsd: number }>();
    let tokens = 0;
    let requests = 0;
    let costUsd = 0;

    for (const row of rows) {
      const total = row.promptTokens + row.completionTokens;
      tokens += total;
      requests += row.requests;
      costUsd += row.costUsd;

      const day = row.day.toISOString().slice(0, 10);
      const entry = byDay.get(day) ?? { tokens: 0, costUsd: 0 };
      entry.tokens += total;
      entry.costUsd += row.costUsd;
      byDay.set(day, entry);
    }

    return {
      tokens,
      requests,
      costUsd: Number(costUsd.toFixed(6)),
      kTokens: Math.ceil(tokens / 1000),
      byDay: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, value]) => ({ day, tokens: value.tokens, costUsd: Number(value.costUsd.toFixed(6)) })),
    };
  }

  // ============================================================ invoices

  /**
   * Issues an invoice for a period.
   *
   * Every line carries the numbers it came from — seat count, rate, tokens
   * used, tokens included. An invoice a customer cannot reconstruct is an
   * invoice they will ask about, and "trust the total" is not an answer.
   */
  async issueInvoice(input: { periodStart?: Date; periodEnd?: Date } = {}): Promise<Invoice> {
    const subscription = await this.requireSubscription();
    const plan = await this.plans.findOrFail(subscription.planKey);

    const periodStart = input.periodStart ?? subscription.currentPeriodStart;
    const periodEnd = input.periodEnd ?? subscription.currentPeriodEnd;

    const lines: Array<Record<string, unknown>> = [];
    let subtotalCents = 0;

    if (plan.priceCents > 0) {
      lines.push({
        kind: 'plan',
        description: `${plan.name} (${plan.interval.toLowerCase()})`,
        quantity: 1,
        unitCents: plan.priceCents,
        amountCents: plan.priceCents,
      });
      subtotalCents += plan.priceCents;
    }

    const extraSeats = Math.max(0, subscription.seats - plan.seatsIncluded);
    if (extraSeats > 0 && plan.seatPriceCents > 0) {
      const amount = extraSeats * plan.seatPriceCents;
      lines.push({
        kind: 'seats',
        description: `${extraSeats} additional seat(s) beyond the ${plan.seatsIncluded} included`,
        quantity: extraSeats,
        unitCents: plan.seatPriceCents,
        amountCents: amount,
      });
      subtotalCents += amount;
    }

    const usage = await this.usageForPeriod(periodStart, periodEnd);
    const billableKTokens = Math.max(0, usage.kTokens - plan.includedKTokens);
    // Rounded once, at the end, rather than per line: rounding each line
    // separately is how a total stops matching the sum of its parts.
    const usageCents = Math.round(billableKTokens * plan.aiOveragePerKTokenCents);

    if (usage.kTokens > 0) {
      lines.push({
        kind: 'ai_usage',
        description: `AI usage: ${usage.tokens.toLocaleString()} tokens across ${usage.requests} request(s)`,
        includedKTokens: plan.includedKTokens,
        usedKTokens: usage.kTokens,
        billableKTokens,
        unitCents: plan.aiOveragePerKTokenCents,
        amountCents: usageCents,
        providerCostUsd: usage.costUsd,
      });
    }

    const number = await this.invoices.nextNumber();
    const invoice = await this.invoices.create({
      subscriptionId: subscription.id,
      number,
      status: 'OPEN',
      currency: plan.currency,
      periodStart,
      periodEnd,
      subtotalCents,
      usageCents,
      totalCents: subtotalCents + usageCents,
      lines: lines as never,
      issuedAt: new Date(),
      dueAt: new Date(Date.now() + 14 * 86_400_000),
    });

    await this.events.publish(DomainEvent.InvoiceIssued, {
      invoiceId: invoice.id,
      number,
      totalCents: invoice.totalCents,
    });
    return invoice;
  }

  invoiceHistory(take = 50): Promise<Invoice[]> {
    return this.invoices.history(take);
  }

  async markPaid(id: string): Promise<Invoice> {
    const invoice = await this.invoices.findByIdOrFail(id);
    if (invoice.status === 'PAID') return invoice;
    return this.invoices.update(id, { status: 'PAID', paidAt: new Date() });
  }

  /**
   * Advances subscriptions whose period has ended. Leader-only, on a schedule.
   *
   * A trial that ends becomes ACTIVE rather than being cut off, because the
   * decision to stop serving a customer belongs to whoever owns the
   * relationship, not to a timer.
   */
  async renewDue(): Promise<{ renewed: number; issued: number }> {
    const due = await this.subscriptions.dueForRenewal();
    let renewed = 0;
    let issued = 0;

    for (const subscription of due) {
      const plan = await this.plans.find(subscription.planKey);
      if (!plan) continue;

      await RequestContextStore.run(
        {
          userId: 'system',
          organizationId: subscription.organizationId,
          roleKey: 'SYSTEM',
          permissions: ['*'],
          requestId: `billing-renew-${subscription.id}`,
        },
        async () => {
          if (subscription.cancelAtPeriodEnd) {
            await this.subscriptions.update(subscription.id, {
              status: 'CANCELLED',
              cancelledAt: new Date(),
            });
            renewed += 1;
            return;
          }

          await this.issueInvoice({
            periodStart: subscription.currentPeriodStart,
            periodEnd: subscription.currentPeriodEnd,
          }).then(() => {
            issued += 1;
          });

          const nextEnd = new Date(Date.now() + BillingService.periodMs(plan.interval));
          await this.subscriptions.update(subscription.id, {
            status: 'ACTIVE',
            trialEndsAt: null,
            currentPeriodStart: new Date(),
            currentPeriodEnd: nextEnd,
          });
          renewed += 1;
        },
      );
    }

    if (renewed) this.logger.log(`Renewed ${renewed} subscription(s), issued ${issued} invoice(s)`);
    return { renewed, issued };
  }

  // ============================================================ reporting

  async overview(): Promise<Record<string, unknown>> {
    const entitlements = await this.entitlements();
    const periodStart = new Date(Date.now() - 30 * 86_400_000);
    const [usage, invoices] = await Promise.all([
      this.usageForPeriod(periodStart, new Date()),
      this.invoices.history(5),
    ]);

    const overage = Math.max(0, usage.kTokens - entitlements.includedKTokens);
    return {
      plan: {
        key: entitlements.planKey,
        name: entitlements.planName,
        status: entitlements.status,
        licensed: entitlements.licensed,
        trialEndsAt: entitlements.trialEndsAt,
      },
      seats: { purchased: entitlements.seats, used: entitlements.seatsUsed },
      features: entitlements.features,
      limits: entitlements.limits,
      usage: {
        windowDays: 30,
        tokens: usage.tokens,
        kTokens: usage.kTokens,
        includedKTokens: entitlements.includedKTokens,
        overageKTokens: overage,
        requests: usage.requests,
        providerCostUsd: usage.costUsd,
        byDay: usage.byDay.slice(-14),
      },
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        totalCents: invoice.totalCents,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
      })),
    };
  }
}
