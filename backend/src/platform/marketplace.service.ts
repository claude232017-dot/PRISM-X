import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import {
  CapabilityRiskLevel,
  GovernanceReviewStatus,
  ListingStatus,
  MarketplaceAssetKind,
  MarketplaceListing,
  MarketplaceVersion,
  Publisher,
  PublisherTrust,
} from '@prisma/client';
import {
  GovernanceReviewRepository,
  MarketplaceListingRepository,
  MarketplaceReviewRepository,
  MarketplaceVersionRepository,
  PublisherRepository,
  SecurityAdvisoryRepository,
} from '../database/repositories/platform.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { analyseUpgrade, digestOf, validate } from './manifest';
import type { ExtensionManifest } from './manifest';
import * as semver from './semver';
import { highestRisk, requiresHumanReview } from './capabilities';
import { ExtensionRuntimeService } from './extension-runtime.service';

/**
 * The marketplace: a shared catalogue of installable assets, and the rules
 * about what may be published into it and installed out of it.
 *
 * Three things here are deliberately not conveniences:
 *
 *  - **Versions are immutable.** Publishing 1.2.0 twice is a conflict, not an
 *    overwrite. An organization that installed 1.2.0 yesterday and one that
 *    installs it tomorrow must get the same thing, or every other guarantee in
 *    Phase 7 — the digest, the signature, the upgrade analysis — describes
 *    something that can change underneath it.
 *
 *  - **Breaking changes are computed at publish time**, by running the same
 *    analysis an installer would run, against the previous version. The
 *    publisher's version number is a claim; the diff is the evidence.
 *
 *  - **Advisories block installs.** A version inside the affected range of a
 *    live advisory cannot be newly installed, whatever its status says.
 */
@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(
    private readonly publishers: PublisherRepository,
    private readonly listings: MarketplaceListingRepository,
    private readonly versions: MarketplaceVersionRepository,
    private readonly reviews: MarketplaceReviewRepository,
    private readonly advisories: SecurityAdvisoryRepository,
    private readonly governance: GovernanceReviewRepository,
    private readonly runtime: ExtensionRuntimeService,
    private readonly events: EventBusService,
  ) {}

  // ============================================================ publishers

  async registerPublisher(input: {
    slug: string;
    displayName: string;
    contactEmail?: string;
    website?: string;
  }): Promise<{ publisher: Publisher; signingKey: string }> {
    if (await this.publishers.findBySlug(input.slug)) {
      throw new ConflictException(`The publisher slug "${input.slug}" is taken`);
    }

    // Ed25519 rather than a shared secret. The platform keeps the public half
    // and can therefore verify a release without ever being able to produce
    // one — which is the only version of "signed" that means anything, since a
    // signature the registry could forge attests to nothing beyond the row
    // having been written.
    //
    // The private half is returned once and never stored.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publisher = await this.publishers.create(input);
    const stored = await this.publishers.updateOwned(publisher.id, {
      signingKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });

    return {
      publisher: stored,
      signingKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
  }

  listPublishers(): Promise<Publisher[]> {
    return this.publishers.list();
  }

  myPublishers(): Promise<Publisher[]> {
    return this.publishers.mine();
  }

  getPublisher(id: string): Promise<Publisher> {
    return this.publishers.findByIdOrFail(id);
  }

  // ============================================================ listings

  async createListing(input: {
    assetKind: MarketplaceAssetKind;
    slug: string;
    name: string;
    summary: string;
    description?: string;
    publisherId: string;
    license?: string;
    homepage?: string;
    documentation?: string;
    tags?: string[];
  }): Promise<MarketplaceListing> {
    const publisher = await this.publishers.findByIdOrFail(input.publisherId);
    this.assertPublisherUsable(publisher);

    if (await this.listings.findBySlug(input.assetKind, input.slug)) {
      throw new ConflictException(
        `A ${input.assetKind.toLowerCase()} called "${input.slug}" already exists`,
      );
    }

    const listing = await this.listings.create({
      assetKind: input.assetKind,
      slug: input.slug,
      name: input.name,
      summary: input.summary,
      description: input.description ?? null,
      publisherId: publisher.id,
      license: input.license ?? 'proprietary',
      homepage: input.homepage ?? null,
      documentation: input.documentation ?? null,
      tags: input.tags ?? [],
      status: ListingStatus.DRAFT,
    });

    await this.publishers.moderate(publisher.id, { listingCount: { increment: 1 } });
    return listing;
  }

  updateListing(id: string, patch: Record<string, unknown>): Promise<MarketplaceListing> {
    const { slug: _immutable, assetKind: _kind, status: _status, ...safe } = patch;
    return this.listings.updateOwned(id, safe);
  }

  search(filter: Parameters<MarketplaceListingRepository['search']>[0]) {
    return this.listings.search({
      // A caller browsing the catalogue sees what is installable, not what is
      // half-written. Asking for another status is allowed and explicit.
      status: filter.status ?? ListingStatus.PUBLISHED,
      ...filter,
    });
  }

  async getListing(id: string): Promise<Record<string, unknown>> {
    const listing = await this.listings.findByIdOrFail(id);
    const [versions, publisher, advisories, mine] = await Promise.all([
      this.versions.all(listing.id),
      this.publishers.findById(listing.publisherId),
      this.advisories.forSlug(listing.slug),
      this.reviews.mine(listing.id),
    ]);

    return {
      ...listing,
      rating: MarketplaceService.average(listing.ratingSum, listing.ratingCount),
      publisher: publisher
        ? { id: publisher.id, slug: publisher.slug, displayName: publisher.displayName, trust: publisher.trust }
        : null,
      versions: versions.map((version) => ({
        version: version.version,
        breaking: version.breaking,
        riskLevel: version.riskLevel,
        capabilities: version.capabilities,
        compatibility: version.compatibility,
        changelog: version.changelog,
        reviewStatus: version.reviewStatus,
        yanked: Boolean(version.yankedAt),
        yankReason: version.yankReason,
        publishedAt: version.publishedAt,
        downloads: version.downloads,
        signed: Boolean(version.signature),
      })),
      advisories: advisories.map((advisory) => ({
        id: advisory.id,
        severity: advisory.severity,
        title: advisory.title,
        affectedRange: advisory.affectedRange,
        patchedVersion: advisory.patchedVersion,
      })),
      myReview: mine ? { rating: mine.rating, title: mine.title, body: mine.body } : null,
    };
  }

  // ============================================================ versions

  /**
   * Publishes a release.
   *
   * The manifest is validated, diffed against the previous release, risk-rated
   * and — when the publisher supplied a signing key — signed. Anything asking
   * for a HIGH or CRITICAL capability opens a governance review rather than
   * going straight to installable.
   */
  async publishVersion(input: {
    listingId: string;
    manifest: unknown;
    changelog?: string;
    signingKey?: string;
  }): Promise<{ version: MarketplaceVersion; breaking: boolean; reviewOpened: boolean }> {
    const listing = await this.listings.findByIdOrFail(input.listingId);
    const publisher = await this.publishers.findByIdOrFail(listing.publisherId);
    this.assertOwner(listing);
    this.assertPublisherUsable(publisher);

    const validation = validate(input.manifest);
    if (!validation.ok || !validation.manifest) {
      throw new BadRequestException({
        message: 'The manifest is not valid',
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }
    const manifest = validation.manifest;

    if (manifest.slug !== listing.slug) {
      throw new BadRequestException(
        `The manifest is for "${manifest.slug}" but this listing is "${listing.slug}"`,
      );
    }
    if (await this.versions.find(listing.id, manifest.version)) {
      throw new ConflictException(
        `${manifest.version} is already published. Versions are immutable — publish a new one.`,
      );
    }

    const published = await this.versions.all(listing.id);
    const previousVersion = semver.highest(
      published.filter((row) => !row.yankedAt).map((row) => row.version),
    );
    if (previousVersion && !semver.gt(manifest.version, previousVersion)) {
      throw new BadRequestException(
        `${manifest.version} is not newer than the published ${previousVersion}`,
      );
    }

    // Breaking is computed, not declared.
    let breaking = false;
    if (previousVersion) {
      const previous = published.find((row) => row.version === previousVersion);
      const previousManifest = previous?.manifest as unknown as ExtensionManifest | undefined;
      if (previousManifest) {
        breaking = analyseUpgrade(previousManifest, manifest).breaking;
      }
    }

    const risk = highestRisk(manifest.capabilities);
    const needsReview = requiresHumanReview(manifest.capabilities);

    const signature = input.signingKey
      ? this.sign(publisher, input.signingKey, validation.digest || digestOf(manifest))
      : null;

    const version = await this.versions.create({
      listingId: listing.id,
      version: manifest.version,
      manifest: manifest as never,
      digest: validation.digest || digestOf(manifest),
      signature,
      signedBy: signature ? publisher.slug : null,
      changelog: input.changelog ?? null,
      breaking,
      capabilities: manifest.capabilities,
      riskLevel: risk as CapabilityRiskLevel,
      compatibility: manifest.engine ?? '*',
      // Low-risk releases are installable immediately; anything that could
      // reach production data waits for a person.
      reviewStatus: needsReview
        ? GovernanceReviewStatus.PENDING
        : GovernanceReviewStatus.APPROVED,
      publishedById: RequestContextStore.get()?.userId ?? null,
    });

    if (!needsReview) {
      await this.promoteLatest(listing, manifest, risk as CapabilityRiskLevel);
    } else {
      await this.governance.create({
        subject: 'LISTING_VERSION',
        subjectId: version.id,
        subjectLabel: `${listing.slug}@${manifest.version}`,
        capabilities: manifest.capabilities,
        riskLevel: risk as CapabilityRiskLevel,
        findings: [
          ...validation.warnings.map((warning) => ({
            code: 'manifest_warning',
            field: warning.field,
            message: warning.message,
          })),
          ...(breaking ? [{ code: 'breaking_release', message: 'Breaking changes vs the previous release' }] : []),
          ...(signature ? [] : [{ code: 'unsigned', message: 'Published without a signature' }]),
        ] as never,
        requestedById: RequestContextStore.get()?.userId ?? null,
      });
      await this.events.publish(DomainEvent.GovernanceReviewOpened, {
        subject: 'LISTING_VERSION',
        subjectId: version.id,
        risk,
      });
    }

    await this.events.publish(DomainEvent.MarketplaceVersionPublished, {
      listingId: listing.id,
      slug: listing.slug,
      version: manifest.version,
      breaking,
      risk,
    });

    return { version, breaking, reviewOpened: needsReview };
  }

  /** Moves the listing head to a version, once that version is installable. */
  private async promoteLatest(
    listing: MarketplaceListing,
    manifest: ExtensionManifest,
    risk: CapabilityRiskLevel,
  ): Promise<void> {
    const isNewest =
      listing.latestVersion === '0.0.0' || semver.gt(manifest.version, listing.latestVersion);
    if (!isNewest) return;

    await this.listings.moderate(listing.id, {
      latestVersion: manifest.version,
      capabilities: manifest.capabilities,
      riskLevel: risk,
      compatibility: manifest.engine ?? '*',
      status: listing.status === ListingStatus.DRAFT ? ListingStatus.PUBLISHED : listing.status,
      publishedAt: listing.publishedAt ?? new Date(),
    });

    if (listing.status === ListingStatus.DRAFT) {
      await this.events.publish(DomainEvent.MarketplaceListingPublished, {
        listingId: listing.id,
        slug: listing.slug,
        assetKind: listing.assetKind,
      });
    }
  }

  /** Called by governance once a pending version is approved. */
  async onVersionApproved(versionId: string): Promise<void> {
    const version = await this.versions.findById(versionId);
    if (!version) return;
    const listing = await this.listings.findByIdOrFail(version.listingId);
    await this.versions.update(version.id, { reviewStatus: GovernanceReviewStatus.APPROVED });
    await this.promoteLatest(
      listing,
      version.manifest as unknown as ExtensionManifest,
      version.riskLevel,
    );
  }

  // ============================================================ installing

  /**
   * Installs a listing version into the calling organization.
   *
   * Everything that could stop the install is checked before the runtime is
   * touched: the listing's status, the publisher's standing, the version's
   * review state, whether it was yanked, whether an advisory covers it, and
   * whether its signature still verifies. Only then does the manifest reach
   * the lifecycle, where the capability grant happens.
   */
  async install(input: {
    listingId: string;
    version?: string;
    config?: Record<string, unknown>;
    dryRun?: boolean;
  }): Promise<unknown> {
    const listing = await this.listings.findByIdOrFail(input.listingId);

    if (listing.status === ListingStatus.SUSPENDED) {
      throw new ForbiddenException(
        `"${listing.slug}" is suspended${listing.suspensionReason ? `: ${listing.suspensionReason}` : ''}`,
      );
    }
    if (listing.status === ListingStatus.DRAFT) {
      throw new NotFoundException(`"${listing.slug}" is not published`);
    }

    const publisher = await this.publishers.findByIdOrFail(listing.publisherId);
    if (publisher.suspendedAt) {
      throw new ForbiddenException(
        `The publisher of "${listing.slug}" is suspended${publisher.suspensionReason ? `: ${publisher.suspensionReason}` : ''}`,
      );
    }

    const wanted = input.version ?? listing.latestVersion;
    const version = await this.versions.find(listing.id, wanted);
    if (!version) throw new NotFoundException(`"${listing.slug}" has no version ${wanted}`);

    if (version.yankedAt) {
      throw new ForbiddenException(
        `${listing.slug}@${wanted} was withdrawn${version.yankReason ? `: ${version.yankReason}` : ''}`,
      );
    }
    if (version.reviewStatus !== GovernanceReviewStatus.APPROVED) {
      throw new ForbiddenException(
        `${listing.slug}@${wanted} is awaiting review and cannot be installed yet`,
      );
    }

    const blocking = (await this.advisories.forSlug(listing.slug)).filter((advisory) =>
      semver.satisfies(wanted, advisory.affectedRange),
    );
    if (blocking.length) {
      const advisory = blocking[0];
      throw new ForbiddenException(
        `${listing.slug}@${wanted} is covered by a ${advisory.severity.toLowerCase()} advisory: ${advisory.title}` +
          (advisory.patchedVersion ? `. Fixed in ${advisory.patchedVersion}.` : ''),
      );
    }

    // The digest is recomputed rather than trusted: a stored digest proves
    // nothing about the stored manifest if both came from the same write.
    const manifest = version.manifest as unknown as ExtensionManifest;
    const recomputed = digestOf(manifest);
    const signatureVerified = version.signature
      ? MarketplaceService.verifySignature(
          publisher.signingKey ?? '',
          recomputed,
          version.signature,
        )
      : false;

    if (version.signature && !signatureVerified) {
      throw new ForbiddenException(
        `The signature on ${listing.slug}@${wanted} does not match its contents`,
      );
    }

    const result = await this.runtime.install({
      manifest,
      config: input.config,
      listingId: listing.id,
      publisherId: publisher.id,
      signature: version.signature ?? undefined,
      signatureVerified,
      dryRun: input.dryRun,
    });

    if (!input.dryRun) {
      await this.listings.bumpCounter(listing.id, 'installCount');
      await this.listings.bumpCounter(listing.id, 'downloads');
      await this.versions.bumpDownloads(version.id);
      await this.events.publish(DomainEvent.MarketplaceListingInstalled, {
        listingId: listing.id,
        slug: listing.slug,
        version: wanted,
      });
    }

    return { ...result, listing: { id: listing.id, slug: listing.slug }, version: wanted };
  }

  /** Available upgrades for an installed extension, newest first. */
  async availableUpgrades(
    listingId: string,
    currentVersion: string,
  ): Promise<Array<{ version: string; breaking: boolean; changelog: string | null }>> {
    const rows = await this.versions.installable(listingId);
    return rows
      .filter((row) => semver.isValid(row.version) && semver.gt(row.version, currentVersion))
      .sort((a, b) => semver.compare(b.version, a.version))
      .map((row) => ({
        version: row.version,
        breaking: row.breaking,
        changelog: row.changelog,
      }));
  }

  // ============================================================ reviews

  async rate(input: {
    listingId: string;
    rating: number;
    title?: string;
    body?: string;
    version?: string;
  }): Promise<unknown> {
    const listing = await this.listings.findByIdOrFail(input.listingId);
    const rating = Math.round(input.rating);
    if (rating < 1 || rating > 5) {
      throw new BadRequestException('A rating must be between 1 and 5');
    }

    const existing = await this.reviews.mine(listing.id);
    const data = {
      listingId: listing.id,
      rating,
      title: input.title ?? null,
      body: input.body ?? null,
      version: input.version ?? listing.latestVersion,
      authorId: RequestContextStore.get()?.userId ?? null,
    };

    const review = existing
      ? await this.reviews.update(existing.id, data)
      : await this.reviews.create(data);

    await this.listings.recomputeRating(listing.id);
    return review;
  }

  // ============================================================ signing

  /**
   * Signs the manifest digest with the publisher's private key.
   *
   * The key is supplied per call and never stored. A signature therefore
   * attests that whoever published this release held the private half at the
   * time — something the platform itself cannot produce.
   */
  private sign(publisher: Publisher, privateKeyPem: string, digest: string): string {
    if (!publisher.signingKey) {
      throw new BadRequestException('This publisher has no signing key registered');
    }
    let signature: Buffer;
    try {
      // Ed25519 takes no separate digest algorithm; the message is signed whole.
      signature = cryptoSign(null, Buffer.from(digest, 'utf8'), privateKeyPem);
    } catch {
      throw new BadRequestException('The supplied signing key is not a valid Ed25519 private key');
    }

    const encoded = signature.toString('base64');
    if (!MarketplaceService.verifySignature(publisher.signingKey, digest, encoded)) {
      throw new ForbiddenException('That signing key does not belong to this publisher');
    }
    return encoded;
  }

  /** True when `signature` was produced for `digest` by the holder of the key. */
  private static verifySignature(
    publicKeyPem: string,
    digest: string,
    signature: string,
  ): boolean {
    try {
      return cryptoVerify(
        null,
        Buffer.from(digest, 'utf8'),
        publicKeyPem,
        Buffer.from(signature, 'base64'),
      );
    } catch {
      // A malformed key or signature is a failed verification, not a crash.
      return false;
    }
  }

  private static average(sum: number, count: number): number {
    return count ? Number((sum / count).toFixed(2)) : 0;
  }

  private assertOwner(listing: MarketplaceListing): void {
    const organizationId = RequestContextStore.require().organizationId;
    if (listing.ownerOrganizationId !== organizationId) {
      throw new NotFoundException(`"${listing.slug}" is not yours to publish to`);
    }
  }

  private assertPublisherUsable(publisher: Publisher): void {
    if (publisher.suspendedAt) {
      throw new ForbiddenException(
        `"${publisher.slug}" is suspended${publisher.suspensionReason ? `: ${publisher.suspensionReason}` : ''}`,
      );
    }
  }

  // ============================================================ reporting

  async overview(): Promise<Record<string, unknown>> {
    const [{ rows: published }, publishers, advisories] = await Promise.all([
      this.listings.search({ status: ListingStatus.PUBLISHED, take: 500 }),
      this.publishers.list(500),
      this.advisories.list(200),
    ]);

    const byKind: Record<string, number> = {};
    for (const listing of published) {
      byKind[listing.assetKind] = (byKind[listing.assetKind] ?? 0) + 1;
    }

    return {
      listings: published.length,
      assetKinds: Object.keys(MarketplaceAssetKind).length,
      byKind,
      publishers: publishers.length,
      verifiedPublishers: publishers.filter((p) => p.trust !== PublisherTrust.UNVERIFIED).length,
      advisories: advisories.length,
      installs: published.reduce((sum, listing) => sum + listing.installCount, 0),
      topRated: published
        .filter((listing) => listing.ratingCount > 0)
        .sort(
          (a, b) =>
            MarketplaceService.average(b.ratingSum, b.ratingCount) -
            MarketplaceService.average(a.ratingSum, a.ratingCount),
        )
        .slice(0, 5)
        .map((listing) => ({
          slug: listing.slug,
          name: listing.name,
          rating: MarketplaceService.average(listing.ratingSum, listing.ratingCount),
          ratings: listing.ratingCount,
        })),
      mostInstalled: published
        .slice()
        .sort((a, b) => b.installCount - a.installCount)
        .slice(0, 5)
        .map((listing) => ({ slug: listing.slug, name: listing.name, installs: listing.installCount })),
    };
  }
}
