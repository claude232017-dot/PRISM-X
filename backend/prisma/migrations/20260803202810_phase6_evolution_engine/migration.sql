-- CreateEnum
CREATE TYPE "EvolutionKind" AS ENUM ('PROMPT_OPTIMIZATION', 'MODEL_CHANGE', 'PROVIDER_CHANGE', 'TOOL_PERMISSION', 'MEMORY_STRATEGY', 'EXECUTION_LIMITS', 'WORKFLOW_STRUCTURE', 'WORKFLOW_PARALLELISM', 'WORKFLOW_SIMPLIFICATION', 'MISSION_TEMPLATE', 'PLANNING_STRATEGY');

-- CreateEnum
CREATE TYPE "EvolutionSubject" AS ENUM ('WORKER', 'WORKFLOW', 'PROVIDER', 'PLANNING', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('DRAFT', 'QUEUED', 'TESTING', 'VALIDATED', 'DEPLOYED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ExperimentMode" AS ENUM ('SANDBOX', 'SHADOW', 'CANARY', 'AB');

-- CreateEnum
CREATE TYPE "EvolutionExperimentStatus" AS ENUM ('RUNNING', 'CONCLUDED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "BenchmarkVerdict" AS ENUM ('BETTER', 'WORSE', 'INCONCLUSIVE', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'REFUSED', 'DEPLOYED', 'MONITORING', 'SETTLED', 'ROLLED_BACK', 'FAILED');

-- CreateEnum
CREATE TYPE "VersionAspect" AS ENUM ('PROMPT', 'MODEL', 'TOOLS', 'MEMORY', 'LIMITS', 'GRAPH', 'STRATEGY');

-- CreateEnum
CREATE TYPE "VersionOrigin" AS ENUM ('MANUAL', 'CANDIDATE', 'ROLLBACK', 'IMPORT');

-- CreateTable
CREATE TABLE "evolution_candidates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "EvolutionKind" NOT NULL,
    "subject" "EvolutionSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expectedBenefit" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "risk" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "status" "CandidateStatus" NOT NULL DEFAULT 'DRAFT',
    "proposedChange" JSONB NOT NULL DEFAULT '{}',
    "rollback" JSONB NOT NULL DEFAULT '{}',
    "sourceRecommendationId" TEXT,
    "proposalCount" INTEGER NOT NULL DEFAULT 1,
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evolution_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evolution_experiments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "mode" "ExperimentMode" NOT NULL DEFAULT 'SANDBOX',
    "status" "EvolutionExperimentStatus" NOT NULL DEFAULT 'RUNNING',
    "name" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "controlVersionId" TEXT,
    "variantVersionId" TEXT,
    "allocation" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "controlTrials" INTEGER NOT NULL DEFAULT 0,
    "variantTrials" INTEGER NOT NULL DEFAULT 0,
    "minTrialsPerArm" INTEGER NOT NULL DEFAULT 10,
    "winner" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "verdict" "BenchmarkVerdict",
    "conclusion" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concludedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evolution_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmarks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "arm" TEXT NOT NULL,
    "trials" INTEGER NOT NULL DEFAULT 0,
    "successes" INTEGER NOT NULL DEFAULT 0,
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "observedRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgCompletionMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "p95CompletionMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgTokens" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgLatencyMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reliability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "userRating" DOUBLE PRECISION,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "roi" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subject" "EvolutionSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "aspect" "VersionAspect" NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "previous" JSONB NOT NULL DEFAULT '{}',
    "label" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "origin" "VersionOrigin" NOT NULL DEFAULT 'MANUAL',
    "candidateId" TEXT,
    "benchmarkId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "candidateId" TEXT,
    "versionId" TEXT,
    "subject" "EvolutionSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT NOT NULL DEFAULT '',
    "kind" "EvolutionKind" NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "applied" JSONB NOT NULL DEFAULT '{}',
    "rollback" JSONB NOT NULL DEFAULT '{}',
    "constitutionVersion" TEXT NOT NULL DEFAULT '',
    "constitutionPassed" BOOLEAN NOT NULL DEFAULT false,
    "lawVerdicts" JSONB NOT NULL DEFAULT '[]',
    "policySatisfied" BOOLEAN NOT NULL DEFAULT false,
    "policyReason" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "deployedById" TEXT,
    "monitorUntil" TIMESTAMP(3),
    "monitoredTrials" INTEGER NOT NULL DEFAULT 0,
    "monitoredFailures" INTEGER NOT NULL DEFAULT 0,
    "healthy" BOOLEAN,
    "rolledBackAt" TIMESTAMP(3),
    "rolledBackById" TEXT,
    "rollbackReason" TEXT,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "benchmarkSummary" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "deployedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evolution_policies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedKinds" "EvolutionKind"[] DEFAULT ARRAY[]::"EvolutionKind"[],
    "requireApproval" "EvolutionKind"[] DEFAULT ARRAY[]::"EvolutionKind"[],
    "allowedModes" "ExperimentMode"[] DEFAULT ARRAY[]::"ExperimentMode"[],
    "autoApproveThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.95,
    "maxUnattendedRisk" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "minTrialsPerArm" INTEGER NOT NULL DEFAULT 10,
    "businessHoursStart" INTEGER,
    "businessHoursEnd" INTEGER,
    "businessDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "maxConcurrentExperiments" INTEGER NOT NULL DEFAULT 3,
    "maxDeploymentsPerDay" INTEGER NOT NULL DEFAULT 5,
    "monitorWindowMinutes" INTEGER NOT NULL DEFAULT 60,
    "autoRollbackThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "autoRollbackEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evolution_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "constitution_violations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "lawId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "subject" "EvolutionSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "kind" "EvolutionKind" NOT NULL,
    "candidateId" TEXT,
    "deploymentId" TEXT,
    "intent" JSONB NOT NULL DEFAULT '{}',
    "constitutionVersion" TEXT NOT NULL DEFAULT '',
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "constitution_violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_strategies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "missionsPlanned" INTEGER NOT NULL DEFAULT 0,
    "successes" INTEGER NOT NULL DEFAULT 0,
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgCompletionMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgTasksPerMission" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "derivedFromId" TEXT,
    "createdById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_strategies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evolution_candidates_organizationId_idx" ON "evolution_candidates"("organizationId");

-- CreateIndex
CREATE INDEX "evolution_candidates_organizationId_status_confidence_idx" ON "evolution_candidates"("organizationId", "status", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "evolution_candidates_organizationId_kind_subjectId_status_key" ON "evolution_candidates"("organizationId", "kind", "subjectId", "status");

-- CreateIndex
CREATE INDEX "evolution_experiments_organizationId_idx" ON "evolution_experiments"("organizationId");

-- CreateIndex
CREATE INDEX "evolution_experiments_organizationId_status_idx" ON "evolution_experiments"("organizationId", "status");

-- CreateIndex
CREATE INDEX "evolution_experiments_candidateId_idx" ON "evolution_experiments"("candidateId");

-- CreateIndex
CREATE INDEX "benchmarks_organizationId_idx" ON "benchmarks"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "benchmarks_experimentId_arm_key" ON "benchmarks"("experimentId", "arm");

-- CreateIndex
CREATE INDEX "entity_versions_organizationId_idx" ON "entity_versions"("organizationId");

-- CreateIndex
CREATE INDEX "entity_versions_organizationId_subject_subjectId_aspect_idx" ON "entity_versions"("organizationId", "subject", "subjectId", "aspect");

-- CreateIndex
CREATE UNIQUE INDEX "entity_versions_organizationId_subject_subjectId_aspect_ver_key" ON "entity_versions"("organizationId", "subject", "subjectId", "aspect", "version");

-- CreateIndex
CREATE INDEX "deployments_organizationId_idx" ON "deployments"("organizationId");

-- CreateIndex
CREATE INDEX "deployments_organizationId_status_createdAt_idx" ON "deployments"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "deployments_organizationId_subject_subjectId_idx" ON "deployments"("organizationId", "subject", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "evolution_policies_organizationId_key" ON "evolution_policies"("organizationId");

-- CreateIndex
CREATE INDEX "constitution_violations_organizationId_idx" ON "constitution_violations"("organizationId");

-- CreateIndex
CREATE INDEX "constitution_violations_organizationId_lawId_createdAt_idx" ON "constitution_violations"("organizationId", "lawId", "createdAt");

-- CreateIndex
CREATE INDEX "planning_strategies_organizationId_idx" ON "planning_strategies"("organizationId");

-- CreateIndex
CREATE INDEX "planning_strategies_organizationId_isActive_idx" ON "planning_strategies"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "planning_strategies_organizationId_name_version_key" ON "planning_strategies"("organizationId", "name", "version");

-- AddForeignKey
ALTER TABLE "evolution_candidates" ADD CONSTRAINT "evolution_candidates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evolution_experiments" ADD CONSTRAINT "evolution_experiments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evolution_experiments" ADD CONSTRAINT "evolution_experiments_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "evolution_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmarks" ADD CONSTRAINT "benchmarks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmarks" ADD CONSTRAINT "benchmarks_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "evolution_experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "evolution_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "entity_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evolution_policies" ADD CONSTRAINT "evolution_policies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constitution_violations" ADD CONSTRAINT "constitution_violations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_strategies" ADD CONSTRAINT "planning_strategies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
