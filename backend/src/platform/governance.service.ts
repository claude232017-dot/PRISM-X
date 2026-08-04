import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AdvisorySeverity,
  ExtensionStatus,
  GovernanceReview,
  GovernanceReviewStatus,
  GovernanceSubject,
  ListingStatus,
  PublisherTrust,
  SecurityAdvisory,
} from '@prisma/client';
import { ExtensionRepository } from '../database/repositories/tenant.repositories';
import {
  GovernanceReviewRepository,
  MarketplaceListingRepository,
  MarketplaceReviewRepository,
  MarketplaceVersionRepository,
  PlatformInstallRepository,
  PublisherRepository,
  SecurityAdvisoryRepository,
} from '../database/repositories/platform.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { ExtensionRuntimeService } from './extension-runtime.service';
import { MarketplaceService } from './marketplace.service';
import { describe as describeCapability, highestRisk } from './capabilities';
import { PLATFORM_API_VERSION, digestOf, validate } from './manifest';
import type { ExtensionManifest } from './manifest';
import * as semver from './semver';

/**
 * Platform governance: the controls that keep a growing ecosystem from
 * degrading the platform underneath it.
 *
 * The distinguishing property of everything here is that it reaches *across*
 * tenants. A moderator suspending a listing, verifying a publisher or issuing
 * an advisory affects organizations that have never met them. That is why
 * `marketplace:moderate` is a separate permission from `marketplace:publish`,
 * why the governance tables carry no tenant scope, and why every decision
 * writes an auditable row rather than mutating a status in place.
 *
 * The one piece of governance that acts on other tenants' data is
 * `enforceAdvisory`, and it is deliberately conservative: it quarantines
 * affected installs rather than uninstalling them, because taking an
 * extension away from an organization is their decision to make once they can
 * see why.
 */
@Injectable()
export class GovernanceService {
  private readonly logger = new Logger(GovernanceService.name);

  constructor(
    private readonly reviews: GovernanceReviewRepository,
    private readonly publishers: PublisherRepository,
    private readonly listings: MarketplaceListingRepository,
    private readonly versions: MarketplaceVersionRepository,
    private readonly advisories: SecurityAdvisoryRepository,
    private readonly listingReviews: MarketplaceReviewRepository,
    private readonly extensions: ExtensionRepository,
    private readonly runtime: ExtensionRuntimeService,
    private readonly marketplace: MarketplaceService,
    private readonly installs: PlatformInstallRepository,
    private readonly events: EventBusService,
  ) {}

  // ============================================================ review queue

  queue(status: GovernanceReviewStatus = GovernanceReviewStatus.PENDING) {
    return this.reviews.queue(status);
  }

  async review(id: string): Promise<Record<string, unknown>> {
    const review = await this.reviews.findByIdOrFail(id);
    return {
      ...review,
      capabilities: review.capabilities.map((capability) => {
        const definition = describeCapability(capability);
        return definition
          ? {
              id: definition.id,
              title: definition.title,
              description: definition.description,
              risk: definition.risk,
            }
          : { id: capability, title: capability, description: 'Unknown capability', risk: 'LOW' };
      }),
    };
  }

  /**
   * Records a decision on a pending review.
   *
   * Approval of a listing version is what makes it installable, so the two
   * happen together rather than as two steps someone could do half of.
   */
  async decide(
    id: string,
    input: { status: GovernanceReviewStatus; notes?: string },
  ): Promise<GovernanceReview> {
    const review = await this.reviews.findByIdOrFail(id);
    if (review.status !== GovernanceReviewStatus.PENDING) {
      throw new BadRequestException(`This review was already ${review.status.toLowerCase()}`);
    }
    if (input.status === GovernanceReviewStatus.PENDING) {
      throw new BadRequestException('A decision cannot be "pending"');
    }

    const context = RequestContextStore.get();
    const decided = await this.reviews.update(id, {
      status: input.status,
      notes: input.notes ?? null,
      reviewerId: context?.userId ?? null,
      decidedAt: new Date(),
    });

    if (review.subject === GovernanceSubject.LISTING_VERSION) {
      if (input.status === GovernanceReviewStatus.APPROVED) {
        await this.marketplace.onVersionApproved(review.subjectId);
      } else {
        await this.versions.update(review.subjectId, { reviewStatus: input.status });
      }
    }

    if (
      review.subject === GovernanceSubject.PUBLISHER &&
      input.status === GovernanceReviewStatus.APPROVED
    ) {
      await this.verifyPublisher(review.subjectId, PublisherTrust.VERIFIED);
    }

    await this.events.publish(DomainEvent.GovernanceReviewDecided, {
      reviewId: id,
      subject: review.subject,
      subjectId: review.subjectId,
      status: input.status,
    });
    return decided;
  }

  // ============================================================ publishers

  async requestVerification(publisherId: string): Promise<GovernanceReview> {
    const publisher = await this.publishers.findByIdOrFail(publisherId);
    const existing = await this.reviews.latestFor(GovernanceSubject.PUBLISHER, publisherId);
    if (existing?.status === GovernanceReviewStatus.PENDING) {
      throw new BadRequestException('A verification request is already open for this publisher');
    }

    const review = await this.reviews.create({
      subject: GovernanceSubject.PUBLISHER,
      subjectId: publisher.id,
      subjectLabel: publisher.slug,
      findings: [
        { code: 'listings', message: `${publisher.listingCount} listing(s) published` },
        ...(publisher.contactEmail ? [] : [{ code: 'no_contact', message: 'No contact address' }]),
        ...(publisher.signingKey ? [] : [{ code: 'no_signing_key', message: 'No signing key registered' }]),
      ] as never,
      requestedById: RequestContextStore.get()?.userId ?? null,
    });

    await this.events.publish(DomainEvent.GovernanceReviewOpened, {
      subject: 'PUBLISHER',
      subjectId: publisher.id,
    });
    return review;
  }

  async verifyPublisher(publisherId: string, trust: PublisherTrust) {
    const publisher = await this.publishers.findByIdOrFail(publisherId);
    const verified = await this.publishers.moderate(publisher.id, {
      trust,
      verifiedAt: trust === PublisherTrust.UNVERIFIED ? null : new Date(),
      verifiedById: RequestContextStore.get()?.userId ?? null,
    });
    await this.events.publish(DomainEvent.PublisherVerified, {
      publisherId,
      slug: publisher.slug,
      trust,
    });
    return verified;
  }

  /**
   * Suspends a publisher and everything they have listed.
   *
   * A publisher acting badly with one listing has not earned trust with the
   * others, so suspension is not per-listing. Existing installs keep running
   * until an advisory says otherwise: suspension stops new exposure, an
   * advisory addresses exposure already taken on.
   */
  async suspendPublisher(publisherId: string, reason: string) {
    const publisher = await this.publishers.findByIdOrFail(publisherId);
    const suspended = await this.publishers.moderate(publisher.id, {
      suspendedAt: new Date(),
      suspensionReason: reason,
    });

    const owned = await this.listings.byPublisher(publisherId, ListingStatus.SUSPENDED);
    for (const listing of owned) {
      await this.suspendListing(listing.id, `Publisher suspended: ${reason}`);
    }

    this.logger.warn(
      `Publisher "${publisher.slug}" suspended, ${owned.length} listing(s) withdrawn: ${reason}`,
    );
    return suspended;
  }

  async reinstatePublisher(publisherId: string) {
    await this.publishers.findByIdOrFail(publisherId);
    return this.publishers.moderate(publisherId, {
      suspendedAt: null,
      suspensionReason: null,
    });
  }

  // ============================================================ listings

  async suspendListing(listingId: string, reason: string) {
    const listing = await this.listings.findByIdOrFail(listingId);
    const suspended = await this.listings.moderate(listing.id, {
      status: ListingStatus.SUSPENDED,
      suspendedAt: new Date(),
      suspensionReason: reason,
    });
    await this.events.publish(DomainEvent.MarketplaceListingSuspended, {
      listingId,
      slug: listing.slug,
      reason,
    });
    return suspended;
  }

  async reinstateListing(listingId: string) {
    const listing = await this.listings.findByIdOrFail(listingId);
    return this.listings.moderate(listing.id, {
      status: listing.publishedAt ? ListingStatus.PUBLISHED : ListingStatus.DRAFT,
      suspendedAt: null,
      suspensionReason: null,
    });
  }

  /**
   * Deprecates a listing. Deliberately not the same as suspending it: a
   * deprecated asset is still installable, because pulling it from under
   * everyone mid-migration is how a deprecation becomes an outage.
   */
  async deprecateListing(listingId: string, notice: string, supersededBySlug?: string) {
    const listing = await this.listings.findByIdOrFail(listingId);
    return this.listings.moderate(listing.id, {
      status: ListingStatus.DEPRECATED,
      deprecatedAt: new Date(),
      deprecationNotice: notice,
      supersededBySlug: supersededBySlug ?? null,
    });
  }

  /** Withdraws one release without touching the rest of the listing. */
  async yankVersion(listingId: string, version: string, reason: string) {
    const row = await this.versions.findOrFail(listingId, version);
    const yanked = await this.versions.update(row.id, {
      yankedAt: new Date(),
      yankReason: reason,
    });

    // The listing head cannot point at a withdrawn release.
    const listing = await this.listings.findByIdOrFail(listingId);
    if (listing.latestVersion === version) {
      const remaining = await this.versions.installable(listingId);
      const highest = semver.highest(
        remaining.filter((candidate) => !candidate.yankedAt).map((candidate) => candidate.version),
      );
      await this.listings.moderate(listingId, { latestVersion: highest ?? '0.0.0' });
    }

    await this.events.publish(DomainEvent.MarketplaceVersionYanked, {
      listingId,
      version,
      reason,
    });
    return yanked;
  }

  async hideReview(reviewId: string, reason: string) {
    const review = await this.listingReviews.findById(reviewId);
    if (!review) throw new NotFoundException(`Review "${reviewId}" was not found`);
    const hidden = await this.listingReviews.update(reviewId, {
      hiddenAt: new Date(),
      hiddenReason: reason,
    });
    await this.listings.recomputeRating(review.listingId);
    return hidden;
  }

  // ============================================================ advisories

  /**
   * Publishes a security advisory and quarantines every affected install.
   *
   * The enforcement half is what makes an advisory more than a note. Without
   * it, "we told everyone" is the whole response, and the organizations most
   * at risk are the ones least likely to be reading the catalogue.
   */
  async publishAdvisory(input: {
    affectedSlug: string;
    severity: AdvisorySeverity;
    title: string;
    summary: string;
    affectedRange: string;
    patchedVersion?: string;
    reference?: string;
    listingId?: string;
  }): Promise<{ advisory: SecurityAdvisory; quarantined: number }> {
    if (!semver.isValidRange(input.affectedRange)) {
      throw new BadRequestException(`"${input.affectedRange}" is not a valid version range`);
    }
    if (input.patchedVersion && !semver.isValid(input.patchedVersion)) {
      throw new BadRequestException(`"${input.patchedVersion}" is not a valid version`);
    }

    const advisory = await this.advisories.create({
      affectedSlug: input.affectedSlug,
      severity: input.severity,
      title: input.title,
      summary: input.summary,
      affectedRange: input.affectedRange,
      patchedVersion: input.patchedVersion ?? null,
      reference: input.reference ?? null,
      listingId: input.listingId ?? null,
      publishedById: RequestContextStore.get()?.userId ?? null,
    });

    const quarantined = await this.enforceAdvisory(advisory);

    await this.events.publish(DomainEvent.SecurityAdvisoryPublished, {
      advisoryId: advisory.id,
      slug: input.affectedSlug,
      severity: input.severity,
      quarantined,
    });
    return { advisory, quarantined };
  }

  /**
   * Quarantines installs of the affected versions, across every organization.
   *
   * This is the one place in Phase 7 that reaches other tenants' rows, and it
   * does so through a repository that says as much rather than through an
   * ad-hoc query — a tenant-scoped repository here would either be lying about
   * its scope or silently protect nobody. The read is unscoped; each quarantine
   * is then performed inside that organization's own request context, so the
   * write stays scoped and the lifecycle event lands in the right tenant.
   */
  private async enforceAdvisory(advisory: SecurityAdvisory): Promise<number> {
    const affected = await this.installs.installsOfSlug(advisory.affectedSlug, [
      ExtensionStatus.INSTALLED,
      ExtensionStatus.ENABLED,
    ]);

    let quarantined = 0;
    for (const install of affected) {
      if (!semver.isValid(install.version)) continue;
      if (!semver.satisfies(install.version, advisory.affectedRange)) continue;

      const reason =
        `${advisory.severity} advisory: ${advisory.title}` +
        (advisory.patchedVersion ? ` — upgrade to ${advisory.patchedVersion}` : '');

      try {
        await RequestContextStore.run(
          {
            userId: 'system',
            organizationId: install.organizationId,
            roleKey: 'SYSTEM',
            permissions: ['*'],
            requestId: `advisory-${advisory.id}`,
          },
          () => this.runtime.quarantine(install.id, reason),
        );
        quarantined += 1;
      } catch (error) {
        // One organization's extension refusing to stop must not prevent the
        // rest from being protected.
        this.logger.error(
          `Failed to quarantine ${install.id} for advisory ${advisory.id}: ${(error as Error).message}`,
        );
      }
    }
    return quarantined;
  }

  async withdrawAdvisory(advisoryId: string, reason: string) {
    const advisory = await this.advisories.findById(advisoryId);
    if (!advisory) throw new NotFoundException(`Advisory "${advisoryId}" was not found`);
    return this.advisories.update(advisoryId, {
      withdrawnAt: new Date(),
      summary: `${advisory.summary}\n\nWithdrawn: ${reason}`,
    });
  }

  listAdvisories() {
    return this.advisories.list();
  }

  // ============================================================ compatibility

  /**
   * Compatibility testing for a published version: everything that can be
   * checked without running the extension.
   *
   * Run against the whole catalogue, this answers "what would break if the
   * platform API moved to 2.0.0" before it moves, which is the question a
   * platform needs answered while it can still change its mind.
   */
  async testCompatibility(
    listingId: string,
    version: string,
    againstApiVersion = PLATFORM_API_VERSION,
  ): Promise<Record<string, unknown>> {
    const row = await this.versions.findOrFail(listingId, version);
    const manifest = row.manifest as unknown as ExtensionManifest;
    const validation = validate(manifest);

    const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
    const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

    add(
      'manifest_valid',
      validation.ok,
      validation.ok ? 'Manifest parses and every field is well-formed' : `${validation.errors.length} error(s)`,
    );

    const engineOk = !manifest.engine || semver.satisfies(againstApiVersion, manifest.engine);
    add(
      'engine_range',
      engineOk,
      manifest.engine
        ? `Declares ${manifest.engine}; testing against ${againstApiVersion}`
        : 'No engine range declared',
    );

    const unknownCapabilities = manifest.capabilities.filter(
      (capability) => !describeCapability(capability),
    );
    add(
      'capabilities_known',
      unknownCapabilities.length === 0,
      unknownCapabilities.length
        ? `Unknown: ${unknownCapabilities.join(', ')}`
        : `${manifest.capabilities.length} capability/capabilities, all in the catalogue`,
    );

    add(
      'digest_matches',
      digestOf(manifest) === row.digest,
      'The stored digest is recomputed from the stored manifest',
    );

    add(
      'signed',
      Boolean(row.signature),
      row.signature ? `Signed by ${row.signedBy}` : 'Unsigned release',
    );

    const dependencies = Object.entries(manifest.dependencies ?? {});
    const dependencyResults = await Promise.all(
      dependencies.map(async ([slug, range]) => {
        const listing = await this.listings.findBySlug('EXTENSION', slug);
        if (!listing) return { slug, range, ok: false, detail: 'Not in the marketplace' };
        const candidates = await this.versions.installable(listing.id);
        const match = candidates.find((candidate) => semver.satisfies(candidate.version, range));
        return {
          slug,
          range,
          ok: Boolean(match),
          detail: match ? `Satisfied by ${match.version}` : 'No published version satisfies the range',
        };
      }),
    );
    add(
      'dependencies_resolvable',
      dependencyResults.every((result) => result.ok),
      dependencies.length ? JSON.stringify(dependencyResults) : 'No dependencies declared',
    );

    return {
      listingId,
      version,
      apiVersion: againstApiVersion,
      compatible: checks.every((check) => check.ok),
      risk: highestRisk(manifest.capabilities),
      checks,
      dependencies: dependencyResults,
      warnings: validation.warnings,
    };
  }

  // ============================================================ reporting

  /** The governance dashboard: standing of the ecosystem as a whole. */
  async overview(): Promise<Record<string, unknown>> {
    const [pending, publishers, advisories, listings] = await Promise.all([
      this.reviews.queue(GovernanceReviewStatus.PENDING, 200),
      this.publishers.list(500),
      this.advisories.list(200),
      this.listings.search({ take: 500, status: undefined as never }),
    ]);

    const bySeverity: Record<string, number> = {};
    for (const advisory of advisories) {
      bySeverity[advisory.severity] = (bySeverity[advisory.severity] ?? 0) + 1;
    }

    return {
      pendingReviews: pending.length,
      pendingByRisk: pending.reduce<Record<string, number>>((acc, review) => {
        acc[review.riskLevel] = (acc[review.riskLevel] ?? 0) + 1;
        return acc;
      }, {}),
      oldestPending: pending.length ? pending[pending.length - 1].createdAt : null,
      publishers: {
        total: publishers.length,
        verified: publishers.filter((p) => p.trust !== PublisherTrust.UNVERIFIED).length,
        suspended: publishers.filter((p) => p.suspendedAt).length,
      },
      listings: {
        total: listings.rows.length,
        published: listings.rows.filter((l) => l.status === ListingStatus.PUBLISHED).length,
        suspended: listings.rows.filter((l) => l.status === ListingStatus.SUSPENDED).length,
        deprecated: listings.rows.filter((l) => l.status === ListingStatus.DEPRECATED).length,
      },
      advisories: { total: advisories.length, bySeverity },
    };
  }

  /**
   * The platform audit log: every governance decision, newest first.
   *
   * Deliberately assembled from the decision rows themselves rather than from
   * a separate log table — a log that can disagree with the decisions it
   * describes is worse than no log.
   */
  async auditLog(take = 100): Promise<Array<Record<string, unknown>>> {
    const decided = await this.reviews.decided(take);

    return decided.map((review) => ({
      at: review.decidedAt,
      action: `review_${review.status.toLowerCase()}`,
      subject: review.subject,
      subjectId: review.subjectId,
      subjectLabel: review.subjectLabel,
      risk: review.riskLevel,
      capabilities: review.capabilities,
      reviewerId: review.reviewerId,
      notes: review.notes,
    }));
  }
}
