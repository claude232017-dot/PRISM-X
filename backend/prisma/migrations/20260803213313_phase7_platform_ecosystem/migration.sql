-- CreateEnum
CREATE TYPE "CapabilityRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ExtensionPhase" AS ENUM ('INSTALL', 'VALIDATE', 'REGISTER', 'INITIALIZE', 'RUN', 'UPDATE', 'MIGRATE', 'DISABLE', 'ENABLE', 'QUARANTINE', 'ROLLBACK', 'UNINSTALL');

-- CreateEnum
CREATE TYPE "LifecycleOutcome" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'REFUSED');

-- CreateEnum
CREATE TYPE "ContributionKind" AS ENUM ('WORKER', 'TOOL', 'TRIGGER');

-- CreateEnum
CREATE TYPE "SandboxDecision" AS ENUM ('ALLOWED', 'DENIED', 'FAILED', 'THROTTLED');

-- CreateEnum
CREATE TYPE "MarketplaceAssetKind" AS ENUM ('EXTENSION', 'WORKER', 'TOOL', 'WORKFLOW', 'CONNECTOR', 'TRIGGER', 'KNOWLEDGE_PACK', 'PROMPT_PACK', 'DASHBOARD', 'POLICY');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'SUSPENDED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "PublisherTrust" AS ENUM ('UNVERIFIED', 'VERIFIED', 'PARTNER', 'OFFICIAL');

-- CreateEnum
CREATE TYPE "AdvisorySeverity" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "GovernanceReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "GovernanceSubject" AS ENUM ('LISTING_VERSION', 'PUBLISHER', 'ADVISORY');

-- CreateEnum
CREATE TYPE "UpgradeOutcome" AS ENUM ('PENDING', 'BLOCKED', 'AWAITING_CONSENT', 'APPLIED', 'FAILED', 'ROLLED_BACK');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExtensionStatus" ADD VALUE 'PENDING_REVIEW';
ALTER TYPE "ExtensionStatus" ADD VALUE 'FAILED';
ALTER TYPE "ExtensionStatus" ADD VALUE 'QUARANTINED';

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "developerAppId" TEXT;

-- AlterTable
ALTER TABLE "extensions" ADD COLUMN     "author" TEXT,
ADD COLUMN     "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "capabilityVersion" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "config" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "dependencies" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "engine" TEXT,
ADD COLUMN     "homepage" TEXT,
ADD COLUMN     "initializedAt" TIMESTAMP(3),
ADD COLUMN     "installedById" TEXT,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "license" TEXT,
ADD COLUMN     "limits" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "listingId" TEXT,
ADD COLUMN     "manifestDigest" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "pendingVersion" TEXT,
ADD COLUMN     "publisherId" TEXT,
ADD COLUMN     "requestedCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "riskLevel" "CapabilityRiskLevel" NOT NULL DEFAULT 'LOW',
ADD COLUMN     "secrets" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "signature" TEXT,
ADD COLUMN     "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "withheldCapabilities" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "extension_lifecycle_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "phase" "ExtensionPhase" NOT NULL,
    "outcome" "LifecycleOutcome" NOT NULL,
    "fromStatus" "ExtensionStatus",
    "toStatus" "ExtensionStatus",
    "version" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "message" TEXT,
    "durationMs" INTEGER,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extension_contributions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "kind" "ContributionKind" NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL DEFAULT '{}',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "workerId" TEXT,
    "triggerId" TEXT,
    "invocations" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastInvokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extension_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extension_state" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extension_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extension_host_calls" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "capability" TEXT,
    "decision" "SandboxDecision" NOT NULL,
    "reason" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "argsPreview" JSONB NOT NULL DEFAULT '{}',
    "contributionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_host_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extension_upgrades" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "fromVersion" TEXT NOT NULL,
    "toVersion" TEXT NOT NULL,
    "release" TEXT NOT NULL DEFAULT 'PATCH',
    "outcome" "UpgradeOutcome" NOT NULL DEFAULT 'PENDING',
    "breaking" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "addedCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "removedCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "migrations" JSONB NOT NULL DEFAULT '[]',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "consentedById" TEXT,
    "consentedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extension_upgrades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishers" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "ownerOrganizationId" TEXT NOT NULL,
    "contactEmail" TEXT,
    "website" TEXT,
    "trust" "PublisherTrust" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "signingKey" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "suspensionReason" TEXT,
    "listingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_listings" (
    "id" TEXT NOT NULL,
    "assetKind" "MarketplaceAssetKind" NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT,
    "publisherId" TEXT NOT NULL,
    "ownerOrganizationId" TEXT NOT NULL,
    "license" TEXT NOT NULL DEFAULT 'proprietary',
    "homepage" TEXT,
    "documentation" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "latestVersion" TEXT NOT NULL DEFAULT '0.0.0',
    "compatibility" TEXT NOT NULL DEFAULT '*',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskLevel" "CapabilityRiskLevel" NOT NULL DEFAULT 'LOW',
    "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "deprecatedAt" TIMESTAMP(3),
    "deprecationNotice" TEXT,
    "supersededBySlug" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "suspensionReason" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_versions" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" JSONB NOT NULL DEFAULT '{}',
    "digest" TEXT NOT NULL DEFAULT '',
    "signature" TEXT,
    "signedBy" TEXT,
    "changelog" TEXT,
    "breaking" BOOLEAN NOT NULL DEFAULT false,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskLevel" "CapabilityRiskLevel" NOT NULL DEFAULT 'LOW',
    "compatibility" TEXT NOT NULL DEFAULT '*',
    "yankedAt" TIMESTAMP(3),
    "yankReason" TEXT,
    "reviewStatus" "GovernanceReviewStatus" NOT NULL DEFAULT 'PENDING',
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_advisories" (
    "id" TEXT NOT NULL,
    "listingId" TEXT,
    "affectedSlug" TEXT NOT NULL,
    "severity" "AdvisorySeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "affectedRange" TEXT NOT NULL,
    "patchedVersion" TEXT,
    "reference" TEXT,
    "raisedByOrgId" TEXT,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "security_advisories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance_reviews" (
    "id" TEXT NOT NULL,
    "subject" "GovernanceSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT NOT NULL DEFAULT '',
    "status" "GovernanceReviewStatus" NOT NULL DEFAULT 'PENDING',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskLevel" "CapabilityRiskLevel" NOT NULL DEFAULT 'LOW',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "reviewerId" TEXT,
    "requestedById" TEXT,
    "requestedByOrgId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "governance_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_reviews" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "version" TEXT,
    "authorId" TEXT,
    "hiddenAt" TIMESTAMP(3),
    "hiddenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "developer_apps" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "homepage" TEXT,
    "publisherId" TEXT,
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "developer_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "developer_api_usage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "appId" TEXT NOT NULL DEFAULT '',
    "apiKeyId" TEXT NOT NULL DEFAULT '',
    "day" DATE NOT NULL,
    "endpoint" TEXT NOT NULL DEFAULT '',
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "throttled" INTEGER NOT NULL DEFAULT 0,
    "totalDurationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "developer_api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "extension_lifecycle_events_organizationId_extensionId_creat_idx" ON "extension_lifecycle_events"("organizationId", "extensionId", "createdAt");

-- CreateIndex
CREATE INDEX "extension_lifecycle_events_organizationId_phase_outcome_idx" ON "extension_lifecycle_events"("organizationId", "phase", "outcome");

-- CreateIndex
CREATE INDEX "extension_contributions_organizationId_extensionId_idx" ON "extension_contributions"("organizationId", "extensionId");

-- CreateIndex
CREATE INDEX "extension_contributions_organizationId_kind_enabled_idx" ON "extension_contributions"("organizationId", "kind", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "extension_contributions_organizationId_kind_key_key" ON "extension_contributions"("organizationId", "kind", "key");

-- CreateIndex
CREATE INDEX "extension_state_organizationId_extensionId_idx" ON "extension_state"("organizationId", "extensionId");

-- CreateIndex
CREATE UNIQUE INDEX "extension_state_extensionId_key_key" ON "extension_state"("extensionId", "key");

-- CreateIndex
CREATE INDEX "extension_host_calls_organizationId_extensionId_createdAt_idx" ON "extension_host_calls"("organizationId", "extensionId", "createdAt");

-- CreateIndex
CREATE INDEX "extension_host_calls_organizationId_decision_createdAt_idx" ON "extension_host_calls"("organizationId", "decision", "createdAt");

-- CreateIndex
CREATE INDEX "extension_upgrades_organizationId_extensionId_createdAt_idx" ON "extension_upgrades"("organizationId", "extensionId", "createdAt");

-- CreateIndex
CREATE INDEX "extension_upgrades_organizationId_outcome_idx" ON "extension_upgrades"("organizationId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "publishers_slug_key" ON "publishers"("slug");

-- CreateIndex
CREATE INDEX "publishers_ownerOrganizationId_idx" ON "publishers"("ownerOrganizationId");

-- CreateIndex
CREATE INDEX "publishers_trust_idx" ON "publishers"("trust");

-- CreateIndex
CREATE INDEX "marketplace_listings_status_assetKind_idx" ON "marketplace_listings"("status", "assetKind");

-- CreateIndex
CREATE INDEX "marketplace_listings_publisherId_idx" ON "marketplace_listings"("publisherId");

-- CreateIndex
CREATE INDEX "marketplace_listings_ownerOrganizationId_idx" ON "marketplace_listings"("ownerOrganizationId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_assetKind_slug_key" ON "marketplace_listings"("assetKind", "slug");

-- CreateIndex
CREATE INDEX "marketplace_versions_listingId_publishedAt_idx" ON "marketplace_versions"("listingId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_versions_listingId_version_key" ON "marketplace_versions"("listingId", "version");

-- CreateIndex
CREATE INDEX "security_advisories_affectedSlug_idx" ON "security_advisories"("affectedSlug");

-- CreateIndex
CREATE INDEX "security_advisories_listingId_idx" ON "security_advisories"("listingId");

-- CreateIndex
CREATE INDEX "security_advisories_severity_publishedAt_idx" ON "security_advisories"("severity", "publishedAt");

-- CreateIndex
CREATE INDEX "governance_reviews_status_createdAt_idx" ON "governance_reviews"("status", "createdAt");

-- CreateIndex
CREATE INDEX "governance_reviews_subject_subjectId_idx" ON "governance_reviews"("subject", "subjectId");

-- CreateIndex
CREATE INDEX "marketplace_reviews_listingId_idx" ON "marketplace_reviews"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_reviews_organizationId_listingId_key" ON "marketplace_reviews"("organizationId", "listingId");

-- CreateIndex
CREATE INDEX "developer_apps_organizationId_idx" ON "developer_apps"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "developer_apps_organizationId_slug_key" ON "developer_apps"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "developer_api_usage_organizationId_day_idx" ON "developer_api_usage"("organizationId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "developer_api_usage_organizationId_appId_apiKeyId_day_endpo_key" ON "developer_api_usage"("organizationId", "appId", "apiKeyId", "day", "endpoint");

-- CreateIndex
CREATE INDEX "api_keys_developerAppId_idx" ON "api_keys"("developerAppId");

-- CreateIndex
CREATE INDEX "extensions_organizationId_status_idx" ON "extensions"("organizationId", "status");

-- CreateIndex
CREATE INDEX "extensions_listingId_idx" ON "extensions"("listingId");

-- AddForeignKey
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "publishers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_developerAppId_fkey" FOREIGN KEY ("developerAppId") REFERENCES "developer_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_lifecycle_events" ADD CONSTRAINT "extension_lifecycle_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_lifecycle_events" ADD CONSTRAINT "extension_lifecycle_events_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_contributions" ADD CONSTRAINT "extension_contributions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_contributions" ADD CONSTRAINT "extension_contributions_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_state" ADD CONSTRAINT "extension_state_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_state" ADD CONSTRAINT "extension_state_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_host_calls" ADD CONSTRAINT "extension_host_calls_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_host_calls" ADD CONSTRAINT "extension_host_calls_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_upgrades" ADD CONSTRAINT "extension_upgrades_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_upgrades" ADD CONSTRAINT "extension_upgrades_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishers" ADD CONSTRAINT "publishers_ownerOrganizationId_fkey" FOREIGN KEY ("ownerOrganizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "publishers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_versions" ADD CONSTRAINT "marketplace_versions_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_advisories" ADD CONSTRAINT "security_advisories_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_reviews" ADD CONSTRAINT "marketplace_reviews_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_reviews" ADD CONSTRAINT "marketplace_reviews_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "developer_apps" ADD CONSTRAINT "developer_apps_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "developer_api_usage" ADD CONSTRAINT "developer_api_usage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
