-- CreateEnum
CREATE TYPE "DeploymentEnvironment" AS ENUM ('DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "InstanceStatus" AS ENUM ('STARTING', 'HEALTHY', 'DRAINING', 'UNREACHABLE', 'STOPPED');

-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('DATABASE', 'STORAGE', 'CONFIGURATION');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'VERIFIED', 'CORRUPT', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RestoreMode" AS ENUM ('FULL', 'POINT_IN_TIME', 'VERIFY_ONLY');

-- CreateEnum
CREATE TYPE "RestoreStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');

-- CreateEnum
CREATE TYPE "MfaMethod" AS ENUM ('TOTP', 'RECOVERY_CODE');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('FIRING', 'RESOLVED', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "RotationScope" AS ENUM ('CREDENTIAL_KEY', 'API_KEY', 'WEBHOOK_SECRET', 'NODE_KEY');

-- CreateEnum
CREATE TYPE "RotationStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'OVERLAPPING');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ComplianceReportKind" AS ENUM ('ACCESS_REVIEW', 'DATA_INVENTORY', 'AUDIT_SUMMARY', 'RETENTION', 'SECURITY_POSTURE');

-- CreateTable
CREATE TABLE "instances" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL DEFAULT 'DEVELOPMENT',
    "version" TEXT NOT NULL DEFAULT '0.0.0',
    "status" "InstanceStatus" NOT NULL DEFAULT 'STARTING',
    "pid" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpuPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memoryMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "activeRequests" INTEGER NOT NULL DEFAULT 0,
    "handledRequests" BIGINT NOT NULL DEFAULT 0,
    "leaderUntil" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backups" (
    "id" TEXT NOT NULL,
    "kind" "BackupKind" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'RUNNING',
    "environment" "DeploymentEnvironment" NOT NULL DEFAULT 'DEVELOPMENT',
    "location" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT NOT NULL DEFAULT '',
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "keyMaterial" JSONB NOT NULL DEFAULT '{}',
    "manifest" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "error" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verificationDetail" TEXT,
    "retentionUntil" TIMESTAMP(3),
    "createdById" TEXT,

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restore_runs" (
    "id" TEXT NOT NULL,
    "backupId" TEXT NOT NULL,
    "mode" "RestoreMode" NOT NULL DEFAULT 'VERIFY_ONLY',
    "status" "RestoreStatus" NOT NULL DEFAULT 'RUNNING',
    "targetTime" TIMESTAMP(3),
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "tablesRestored" INTEGER NOT NULL DEFAULT 0,
    "rowsRestored" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "error" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "runById" TEXT,

    CONSTRAINT "restore_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "metric" TEXT NOT NULL,
    "comparison" TEXT NOT NULL DEFAULT 'gt',
    "threshold" DOUBLE PRECISION NOT NULL,
    "forSeconds" INTEGER NOT NULL DEFAULT 60,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'FIRING',
    "value" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "detail" TEXT,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_rotations" (
    "id" TEXT NOT NULL,
    "scope" "RotationScope" NOT NULL,
    "status" "RotationStatus" NOT NULL DEFAULT 'RUNNING',
    "newKeyId" TEXT NOT NULL DEFAULT '',
    "previousKeyId" TEXT NOT NULL DEFAULT '',
    "itemsRotated" INTEGER NOT NULL DEFAULT 0,
    "itemsFailed" INTEGER NOT NULL DEFAULT 0,
    "overlapUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "actorId" TEXT,

    CONSTRAINT "secret_rotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "releases" (
    "id" TEXT NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL,
    "version" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL DEFAULT '',
    "status" "ReleaseStatus" NOT NULL DEFAULT 'PENDING',
    "previousVersion" TEXT,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "migrationsApplied" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "error" TEXT,
    "rollbackOfId" TEXT,
    "actorId" TEXT,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readiness_reviews" (
    "id" TEXT NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL,
    "version" TEXT NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "verdicts" JSONB NOT NULL DEFAULT '[]',
    "blockers" INTEGER NOT NULL DEFAULT 0,
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "readiness_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "interval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
    "seatsIncluded" INTEGER NOT NULL DEFAULT 1,
    "seatPriceCents" INTEGER NOT NULL DEFAULT 0,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "limits" JSONB NOT NULL DEFAULT '{}',
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "aiOveragePerKTokenCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "includedKTokens" INTEGER NOT NULL DEFAULT 0,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "seats" INTEGER NOT NULL DEFAULT 1,
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "usageCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "mfaSatisfied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_enrollments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" "MfaMethod" NOT NULL DEFAULT 'TOTP',
    "secret" JSONB NOT NULL DEFAULT '{}',
    "recoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confirmedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mfa_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_allow_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_allow_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_reports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "ComplianceReportKind" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '{}',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "generatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instances_instanceId_key" ON "instances"("instanceId");

-- CreateIndex
CREATE INDEX "instances_status_lastHeartbeat_idx" ON "instances"("status", "lastHeartbeat");

-- CreateIndex
CREATE INDEX "instances_leaderUntil_idx" ON "instances"("leaderUntil");

-- CreateIndex
CREATE INDEX "backups_kind_status_startedAt_idx" ON "backups"("kind", "status", "startedAt");

-- CreateIndex
CREATE INDEX "backups_retentionUntil_idx" ON "backups"("retentionUntil");

-- CreateIndex
CREATE INDEX "restore_runs_backupId_startedAt_idx" ON "restore_runs"("backupId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rules_key_key" ON "alert_rules"("key");

-- CreateIndex
CREATE INDEX "alert_rules_enabled_severity_idx" ON "alert_rules"("enabled", "severity");

-- CreateIndex
CREATE INDEX "alert_events_status_firedAt_idx" ON "alert_events"("status", "firedAt");

-- CreateIndex
CREATE INDEX "alert_events_ruleKey_firedAt_idx" ON "alert_events"("ruleKey", "firedAt");

-- CreateIndex
CREATE INDEX "secret_rotations_scope_startedAt_idx" ON "secret_rotations"("scope", "startedAt");

-- CreateIndex
CREATE INDEX "releases_environment_startedAt_idx" ON "releases"("environment", "startedAt");

-- CreateIndex
CREATE INDEX "releases_status_idx" ON "releases"("status");

-- CreateIndex
CREATE INDEX "readiness_reviews_environment_createdAt_idx" ON "readiness_reviews"("environment", "createdAt");

-- CreateIndex
CREATE INDEX "plans_active_sortOrder_idx" ON "plans"("active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organizationId_key" ON "subscriptions"("organizationId");

-- CreateIndex
CREATE INDEX "subscriptions_organizationId_idx" ON "subscriptions"("organizationId");

-- CreateIndex
CREATE INDEX "subscriptions_status_currentPeriodEnd_idx" ON "subscriptions"("status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "invoices_organizationId_periodStart_idx" ON "invoices"("organizationId", "periodStart");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organizationId_number_key" ON "invoices"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_tokenHash_key" ON "user_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "user_sessions_organizationId_userId_idx" ON "user_sessions"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "user_sessions_expiresAt_idx" ON "user_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_enrollments_userId_key" ON "mfa_enrollments"("userId");

-- CreateIndex
CREATE INDEX "ip_allow_entries_organizationId_enabled_idx" ON "ip_allow_entries"("organizationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ip_allow_entries_organizationId_cidr_key" ON "ip_allow_entries"("organizationId", "cidr");

-- CreateIndex
CREATE INDEX "compliance_reports_organizationId_kind_createdAt_idx" ON "compliance_reports"("organizationId", "kind", "createdAt");

-- AddForeignKey
ALTER TABLE "restore_runs" ADD CONSTRAINT "restore_runs_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "backups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planKey_fkey" FOREIGN KEY ("planKey") REFERENCES "plans"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ip_allow_entries" ADD CONSTRAINT "ip_allow_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_reports" ADD CONSTRAINT "compliance_reports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
