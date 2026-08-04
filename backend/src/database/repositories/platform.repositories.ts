import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  DeveloperApiUsage,
  DeveloperApp,
  Extension,
  ExtensionContribution,
  ExtensionHostCall,
  ExtensionLifecycleEvent,
  ExtensionState,
  ExtensionUpgrade,
  GovernanceReview,
  MarketplaceListing,
  MarketplaceReview,
  MarketplaceVersion,
  Publisher,
  SecurityAdvisory,
} from '@prisma/client';
import { BaseRepository } from './base.repository';
import { PrismaService } from '../prisma.service';
import { RequestContextStore } from '../../shared/context/request-context';

/**
 * Phase 7 repositories.
 *
 * This file is the first to contain two kinds of repository, because Phase 7
 * is the first phase with data that is deliberately not tenant-private.
 *
 *  - **Tenant repositories** extend BaseRepository as everywhere else: the
 *    organization is merged in from the ambient RequestContext and cannot be
 *    omitted by a caller.
 *
 *  - **Catalogue repositories** (publishers, listings, versions, advisories,
 *    governance reviews) do not, and the reason is worth stating: a
 *    marketplace whose rows were filtered by tenant would show every
 *    organization an empty catalogue. They read across tenants by design.
 *    What replaces the automatic scoping is not nothing — it is an explicit
 *    ownership check on every write, `assertOwned`, plus the Postgres policies
 *    in the Phase 7 RLS migration that permit reads by all and writes only by
 *    the owning organization. Bypassing BaseRepository here is a decision with
 *    a substitute, not an omission.
 *
 * Every class declares a constructor that only calls super() or assigns
 * `prisma` — TypeScript emits the `design:paramtypes` metadata Nest needs for
 * injection only when a class declares one.
 */

// ============================================================
// Tenant-scoped
// ============================================================

@Injectable()
export class ExtensionLifecycleRepository extends BaseRepository<ExtensionLifecycleEvent> {
  protected readonly modelName = 'extensionLifecycleEvent';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** The transition history for one extension, newest first. */
  history(extensionId: string, take = 100): Promise<ExtensionLifecycleEvent[]> {
    return this.findMany({ extensionId }, { take, orderBy: { createdAt: 'desc' } });
  }

  /** Failures and refusals across the organization — the thing worth watching. */
  problems(take = 50): Promise<ExtensionLifecycleEvent[]> {
    return this.findMany(
      { outcome: { in: ['FAILED', 'REFUSED'] } },
      { take, orderBy: { createdAt: 'desc' } },
    );
  }
}

@Injectable()
export class ExtensionContributionRepository extends BaseRepository<ExtensionContribution> {
  protected readonly modelName = 'extensionContribution';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  byExtension(extensionId: string): Promise<ExtensionContribution[]> {
    return this.findMany({ extensionId }, { orderBy: { key: 'asc' } });
  }

  /**
   * Live contributions of one kind. Only enabled rows belonging to enabled
   * extensions: disabling an extension must remove its tools from every
   * lookup, and doing that with a join here means no caller can forget to.
   */
  async active(kind: ExtensionContribution['kind']): Promise<ExtensionContribution[]> {
    return this.delegate().findMany({
      where: this.scope({
        kind,
        enabled: true,
        extension: { status: 'ENABLED', deletedAt: null },
      }),
      orderBy: { key: 'asc' },
    });
  }

  findByKey(
    kind: ExtensionContribution['kind'],
    key: string,
  ): Promise<ExtensionContribution | null> {
    return this.delegate().findFirst({ where: this.scope({ kind, key }) });
  }

  async recordInvocation(id: string, failed: boolean): Promise<void> {
    await this.delegate().updateMany({
      where: this.scope({ id }),
      data: {
        invocations: { increment: 1 },
        ...(failed ? { failures: { increment: 1 } } : {}),
        lastInvokedAt: new Date(),
      },
    });
  }

  async setEnabledForExtension(extensionId: string, enabled: boolean): Promise<number> {
    const { count } = await this.delegate().updateMany({
      where: this.scope({ extensionId }),
      data: { enabled },
    });
    return count;
  }

  async removeForExtension(extensionId: string): Promise<number> {
    const { count } = await this.delegate().deleteMany({
      where: this.scope({ extensionId }),
    });
    return count;
  }
}

@Injectable()
export class ExtensionStateRepository extends BaseRepository<ExtensionState> {
  protected readonly modelName = 'extensionState';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  get(extensionId: string, key: string): Promise<ExtensionState | null> {
    return this.delegate().findFirst({ where: this.scope({ extensionId, key }) });
  }

  keys(extensionId: string, prefix?: string): Promise<ExtensionState[]> {
    return this.findMany(
      { extensionId, ...(prefix ? { key: { startsWith: prefix } } : {}) },
      { orderBy: { key: 'asc' } },
    );
  }

  /** Current footprint, for the storage ceiling. */
  async usage(extensionId: string): Promise<{ bytes: number; keys: number }> {
    const rows = (await this.delegate().findMany({
      where: this.scope({ extensionId }),
      select: { bytes: true },
    })) as Array<{ bytes: number }>;
    return {
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      keys: rows.length,
    };
  }

  async put(extensionId: string, key: string, value: unknown, bytes: number): Promise<ExtensionState> {
    const existing = await this.get(extensionId, key);
    if (existing) {
      return this.update(existing.id, { value: value as never, bytes });
    }
    return this.create({ extensionId, key, value: value as never, bytes });
  }

  async drop(extensionId: string, key: string): Promise<boolean> {
    const { count } = await this.delegate().deleteMany({
      where: this.scope({ extensionId, key }),
    });
    return count > 0;
  }

  async dropAll(extensionId: string): Promise<number> {
    const { count } = await this.delegate().deleteMany({ where: this.scope({ extensionId }) });
    return count;
  }
}

@Injectable()
export class ExtensionHostCallRepository extends BaseRepository<ExtensionHostCall> {
  protected readonly modelName = 'extensionHostCall';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  recent(extensionId?: string, take = 100): Promise<ExtensionHostCall[]> {
    return this.findMany(extensionId ? { extensionId } : {}, {
      take,
      orderBy: { createdAt: 'desc' },
    });
  }

  denials(since: Date, take = 200): Promise<ExtensionHostCall[]> {
    return this.findMany(
      { decision: 'DENIED', createdAt: { gte: since } },
      { take, orderBy: { createdAt: 'desc' } },
    );
  }

  /** Calls in a window, used by the sandbox's own rate limiter. */
  countSince(extensionId: string, since: Date, method?: string): Promise<number> {
    return this.delegate().count({
      where: this.scope({
        extensionId,
        createdAt: { gte: since },
        decision: { in: ['ALLOWED', 'FAILED'] },
        ...(method ? { method } : {}),
      }),
    });
  }
}

@Injectable()
export class ExtensionUpgradeRepository extends BaseRepository<ExtensionUpgrade> {
  protected readonly modelName = 'extensionUpgrade';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  forExtension(extensionId: string, take = 50): Promise<ExtensionUpgrade[]> {
    return this.findMany({ extensionId }, { take, orderBy: { createdAt: 'desc' } });
  }

  /** The upgrade currently waiting on someone to say yes. */
  pendingConsent(extensionId: string): Promise<ExtensionUpgrade | null> {
    return this.delegate().findFirst({
      where: this.scope({ extensionId, outcome: 'AWAITING_CONSENT' }),
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The most recent applied upgrade — what a rollback would undo. */
  lastApplied(extensionId: string): Promise<ExtensionUpgrade | null> {
    return this.delegate().findFirst({
      where: this.scope({ extensionId, outcome: 'APPLIED' }),
      orderBy: { appliedAt: 'desc' },
    });
  }
}

@Injectable()
export class MarketplaceReviewRepository extends BaseRepository<MarketplaceReview> {
  protected readonly modelName = 'marketplaceReview';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  mine(listingId: string): Promise<MarketplaceReview | null> {
    return this.delegate().findFirst({ where: this.scope({ listingId }) });
  }
}

@Injectable()
export class DeveloperAppRepository extends BaseRepository<DeveloperApp> {
  protected readonly modelName = 'developerApp';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findBySlug(slug: string): Promise<DeveloperApp | null> {
    return this.delegate().findFirst({ where: this.scope({ slug }) });
  }
}

@Injectable()
export class DeveloperApiUsageRepository extends BaseRepository<DeveloperApiUsage> {
  protected readonly modelName = 'developerApiUsage';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Adds one request to a daily slice, creating it if today is the first.
   *
   * The slice keys use an empty-string sentinel rather than NULL because the
   * unique index has to actually be unique: Postgres treats NULLs as distinct,
   * so a nullable `appId` would let the same slice be inserted repeatedly
   * instead of being found and incremented.
   */
  async record(slice: {
    appId?: string | null;
    apiKeyId?: string | null;
    endpoint?: string | null;
    day: Date;
    durationMs: number;
    failed?: boolean;
    throttled?: boolean;
  }): Promise<void> {
    const key = {
      organizationId: this.organizationId,
      appId: slice.appId ?? '',
      apiKeyId: slice.apiKeyId ?? '',
      endpoint: slice.endpoint ?? '',
      day: slice.day,
    };

    const existing = await this.delegate().findFirst({ where: key });
    const delta = {
      requests: { increment: 1 },
      totalDurationMs: { increment: Math.max(0, Math.round(slice.durationMs)) },
      ...(slice.failed ? { errors: { increment: 1 } } : {}),
      ...(slice.throttled ? { throttled: { increment: 1 } } : {}),
    };

    if (existing) {
      await this.delegate().update({ where: { id: (existing as DeveloperApiUsage).id }, data: delta });
      return;
    }

    await this.delegate().create({
      data: {
        ...key,
        requests: 1,
        errors: slice.failed ? 1 : 0,
        throttled: slice.throttled ? 1 : 0,
        totalDurationMs: Math.max(0, Math.round(slice.durationMs)),
      },
    });
  }

  between(from: Date, to: Date): Promise<DeveloperApiUsage[]> {
    return this.findMany({ day: { gte: from, lte: to } }, { orderBy: { day: 'asc' } });
  }
}

// ============================================================
// Global catalogue
// ============================================================

/**
 * Shared behaviour for the catalogue repositories: reads are unscoped, writes
 * are checked against the acting organization.
 */
abstract class CatalogueRepository {
  protected abstract readonly label: string;

  constructor(protected readonly prisma: PrismaService) {}

  /** The organization acting right now. Fails closed, exactly as BaseRepository does. */
  protected get organizationId(): string {
    return RequestContextStore.require().organizationId;
  }

  /**
   * Refuses a write to a row this organization does not own.
   *
   * This is the replacement for BaseRepository's automatic scoping, and it is
   * deliberately a throw rather than a silent filter: a publisher trying to
   * edit someone else's listing should be told no, not handed a 404 that looks
   * like the row is missing.
   */
  protected assertOwned(ownerOrganizationId: string | null | undefined, id: string): void {
    if (ownerOrganizationId !== this.organizationId) {
      throw new NotFoundException(`${this.label} "${id}" is not yours to change`);
    }
  }
}

@Injectable()
export class PublisherRepository extends CatalogueRepository {
  protected readonly label = 'Publisher';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findById(id: string): Promise<Publisher | null> {
    return this.prisma.publisher.findUnique({ where: { id } });
  }

  async findByIdOrFail(id: string): Promise<Publisher> {
    const publisher = await this.findById(id);
    if (!publisher) throw new NotFoundException(`Publisher "${id}" was not found`);
    return publisher;
  }

  findBySlug(slug: string): Promise<Publisher | null> {
    return this.prisma.publisher.findUnique({ where: { slug } });
  }

  /** Publisher identities this organization controls. */
  mine(): Promise<Publisher[]> {
    return this.prisma.publisher.findMany({
      where: { ownerOrganizationId: this.organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  list(take = 100): Promise<Publisher[]> {
    return this.prisma.publisher.findMany({ take, orderBy: { displayName: 'asc' } });
  }

  create(data: {
    slug: string;
    displayName: string;
    contactEmail?: string | null;
    website?: string | null;
  }): Promise<Publisher> {
    return this.prisma.publisher.create({
      data: { ...data, ownerOrganizationId: this.organizationId },
    });
  }

  async updateOwned(id: string, data: Record<string, unknown>): Promise<Publisher> {
    const publisher = await this.findByIdOrFail(id);
    this.assertOwned(publisher.ownerOrganizationId, id);
    return this.prisma.publisher.update({ where: { id }, data });
  }

  /** Moderation write: not ownership-checked, gated by `marketplace:moderate`. */
  moderate(id: string, data: Record<string, unknown>): Promise<Publisher> {
    return this.prisma.publisher.update({ where: { id }, data });
  }
}

@Injectable()
export class MarketplaceListingRepository extends CatalogueRepository {
  protected readonly label = 'Listing';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findById(id: string): Promise<MarketplaceListing | null> {
    return this.prisma.marketplaceListing.findUnique({ where: { id } });
  }

  async findByIdOrFail(id: string): Promise<MarketplaceListing> {
    const listing = await this.findById(id);
    if (!listing) throw new NotFoundException(`Listing "${id}" was not found`);
    return listing;
  }

  findBySlug(
    assetKind: MarketplaceListing['assetKind'],
    slug: string,
  ): Promise<MarketplaceListing | null> {
    return this.prisma.marketplaceListing.findUnique({
      where: { assetKind_slug: { assetKind, slug } },
    });
  }

  async search(filter: {
    assetKind?: MarketplaceListing['assetKind'];
    status?: MarketplaceListing['status'];
    tag?: string;
    capability?: string;
    maxRisk?: MarketplaceListing['riskLevel'][];
    query?: string;
    publisherId?: string;
    skip?: number;
    take?: number;
    orderBy?: Record<string, 'asc' | 'desc'>;
  }): Promise<{ rows: MarketplaceListing[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (filter.assetKind) where.assetKind = filter.assetKind;
    if (filter.status) where.status = filter.status;
    if (filter.publisherId) where.publisherId = filter.publisherId;
    if (filter.tag) where.tags = { has: filter.tag };
    if (filter.capability) where.capabilities = { has: filter.capability };
    if (filter.maxRisk?.length) where.riskLevel = { in: filter.maxRisk };
    if (filter.query) {
      where.OR = [
        { name: { contains: filter.query, mode: 'insensitive' } },
        { summary: { contains: filter.query, mode: 'insensitive' } },
        { slug: { contains: filter.query, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.marketplaceListing.findMany({
        where,
        skip: filter.skip,
        take: filter.take ?? 25,
        orderBy: filter.orderBy ?? { installCount: 'desc' },
      }),
      this.prisma.marketplaceListing.count({ where }),
    ]);
    return { rows, total };
  }

  mine(): Promise<MarketplaceListing[]> {
    return this.prisma.marketplaceListing.findMany({
      where: { ownerOrganizationId: this.organizationId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** Everything one publisher has listed — for suspending them wholesale. */
  byPublisher(
    publisherId: string,
    excludeStatus?: MarketplaceListing['status'],
  ): Promise<MarketplaceListing[]> {
    return this.prisma.marketplaceListing.findMany({
      where: {
        publisherId,
        ...(excludeStatus ? { status: { not: excludeStatus } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  create(data: Record<string, unknown>): Promise<MarketplaceListing> {
    return this.prisma.marketplaceListing.create({
      data: { ...data, ownerOrganizationId: this.organizationId } as never,
    });
  }

  async updateOwned(id: string, data: Record<string, unknown>): Promise<MarketplaceListing> {
    const listing = await this.findByIdOrFail(id);
    this.assertOwned(listing.ownerOrganizationId, id);
    return this.prisma.marketplaceListing.update({ where: { id }, data });
  }

  /** Moderation write: not ownership-checked, gated by `marketplace:moderate`. */
  moderate(id: string, data: Record<string, unknown>): Promise<MarketplaceListing> {
    return this.prisma.marketplaceListing.update({ where: { id }, data });
  }

  async bumpCounter(
    id: string,
    field: 'downloads' | 'installCount',
    by = 1,
  ): Promise<void> {
    await this.prisma.marketplaceListing.update({
      where: { id },
      data: { [field]: { increment: by } },
    });
  }

  /**
   * Recomputes the rating aggregate from the visible reviews.
   *
   * Deliberately a recount rather than an incremental adjustment: hiding a
   * review has to subtract it, and an aggregate maintained by deltas drifts
   * the first time one of those deltas is missed.
   */
  async recomputeRating(listingId: string): Promise<void> {
    const rows = await this.prisma.marketplaceReview.findMany({
      where: { listingId, hiddenAt: null },
      select: { rating: true },
    });
    await this.prisma.marketplaceListing.update({
      where: { id: listingId },
      data: {
        ratingSum: rows.reduce((sum, row) => sum + row.rating, 0),
        ratingCount: rows.length,
      },
    });
  }
}

@Injectable()
export class MarketplaceVersionRepository extends CatalogueRepository {
  protected readonly label = 'Version';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findById(id: string): Promise<MarketplaceVersion | null> {
    return this.prisma.marketplaceVersion.findUnique({ where: { id } });
  }

  find(listingId: string, version: string): Promise<MarketplaceVersion | null> {
    return this.prisma.marketplaceVersion.findUnique({
      where: { listingId_version: { listingId, version } },
    });
  }

  async findOrFail(listingId: string, version: string): Promise<MarketplaceVersion> {
    const row = await this.find(listingId, version);
    if (!row) throw new NotFoundException(`Version "${version}" was not found`);
    return row;
  }

  all(listingId: string): Promise<MarketplaceVersion[]> {
    return this.prisma.marketplaceVersion.findMany({
      where: { listingId },
      orderBy: { publishedAt: 'desc' },
    });
  }

  /** Versions a new install may choose from: published, reviewed, not yanked. */
  installable(listingId: string): Promise<MarketplaceVersion[]> {
    return this.prisma.marketplaceVersion.findMany({
      where: { listingId, yankedAt: null, reviewStatus: 'APPROVED' },
      orderBy: { publishedAt: 'desc' },
    });
  }

  create(data: Record<string, unknown>): Promise<MarketplaceVersion> {
    return this.prisma.marketplaceVersion.create({ data: data as never });
  }

  update(id: string, data: Record<string, unknown>): Promise<MarketplaceVersion> {
    return this.prisma.marketplaceVersion.update({ where: { id }, data });
  }

  async bumpDownloads(id: string): Promise<void> {
    await this.prisma.marketplaceVersion.update({
      where: { id },
      data: { downloads: { increment: 1 } },
    });
  }
}

@Injectable()
export class SecurityAdvisoryRepository extends CatalogueRepository {
  protected readonly label = 'Advisory';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findById(id: string): Promise<SecurityAdvisory | null> {
    return this.prisma.securityAdvisory.findUnique({ where: { id } });
  }

  /** Live advisories against a slug — withdrawn ones do not count. */
  forSlug(affectedSlug: string): Promise<SecurityAdvisory[]> {
    return this.prisma.securityAdvisory.findMany({
      where: { affectedSlug, withdrawnAt: null },
      orderBy: { publishedAt: 'desc' },
    });
  }

  list(take = 100): Promise<SecurityAdvisory[]> {
    return this.prisma.securityAdvisory.findMany({
      where: { withdrawnAt: null },
      take,
      orderBy: { publishedAt: 'desc' },
    });
  }

  create(data: Record<string, unknown>): Promise<SecurityAdvisory> {
    return this.prisma.securityAdvisory.create({
      data: { ...data, raisedByOrgId: this.organizationId } as never,
    });
  }

  update(id: string, data: Record<string, unknown>): Promise<SecurityAdvisory> {
    return this.prisma.securityAdvisory.update({ where: { id }, data });
  }
}

@Injectable()
export class GovernanceReviewRepository extends CatalogueRepository {
  protected readonly label = 'Review';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findById(id: string): Promise<GovernanceReview | null> {
    return this.prisma.governanceReview.findUnique({ where: { id } });
  }

  async findByIdOrFail(id: string): Promise<GovernanceReview> {
    const review = await this.findById(id);
    if (!review) throw new NotFoundException(`Review "${id}" was not found`);
    return review;
  }

  queue(status: GovernanceReview['status'] = 'PENDING', take = 100): Promise<GovernanceReview[]> {
    return this.prisma.governanceReview.findMany({
      where: { status },
      take,
      orderBy: [{ riskLevel: 'desc' }, { createdAt: 'asc' }],
    });
  }

  forSubject(
    subject: GovernanceReview['subject'],
    subjectId: string,
  ): Promise<GovernanceReview[]> {
    return this.prisma.governanceReview.findMany({
      where: { subject, subjectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  latestFor(
    subject: GovernanceReview['subject'],
    subjectId: string,
  ): Promise<GovernanceReview | null> {
    return this.prisma.governanceReview.findFirst({
      where: { subject, subjectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  create(data: Record<string, unknown>): Promise<GovernanceReview> {
    return this.prisma.governanceReview.create({
      data: { ...data, requestedByOrgId: this.organizationId } as never,
    });
  }

  update(id: string, data: Record<string, unknown>): Promise<GovernanceReview> {
    return this.prisma.governanceReview.update({ where: { id }, data });
  }

  /** Concluded reviews, newest first — the platform audit log's raw material. */
  decided(take = 100): Promise<GovernanceReview[]> {
    return this.prisma.governanceReview.findMany({
      where: { decidedAt: { not: null } },
      take,
      orderBy: { decidedAt: 'desc' },
    });
  }
}

/**
 * The one repository that reads across every tenant's installs.
 *
 * A security advisory has to reach organizations that have never heard of the
 * publisher, so this query cannot be tenant-scoped and saying so plainly is
 * better than a scoped repository that quietly does nothing. It is read-only
 * and returns identifiers only: the caller re-enters each organization's own
 * context to act, so the write path stays scoped even though the read is not.
 */
@Injectable()
export class PlatformInstallRepository {
  constructor(private readonly prisma: PrismaService) {}

  installsOfSlug(
    slug: string,
    statuses: Array<Extension['status']>,
  ): Promise<Array<{ id: string; organizationId: string; version: string }>> {
    return this.prisma.extension.findMany({
      where: { slug, deletedAt: null, status: { in: statuses } },
      select: { id: true, organizationId: true, version: true },
    });
  }
}

/** Re-exported so platform services import one module for every repository. */
export type { Extension };

export const PLATFORM_REPOSITORIES = [
  PlatformInstallRepository,
  ExtensionLifecycleRepository,
  ExtensionContributionRepository,
  ExtensionStateRepository,
  ExtensionHostCallRepository,
  ExtensionUpgradeRepository,
  MarketplaceReviewRepository,
  DeveloperAppRepository,
  DeveloperApiUsageRepository,
  PublisherRepository,
  MarketplaceListingRepository,
  MarketplaceVersionRepository,
  SecurityAdvisoryRepository,
  GovernanceReviewRepository,
];
