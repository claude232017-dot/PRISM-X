-- CreateEnum
CREATE TYPE "ReviewOutcome" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILURE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MetricSubject" AS ENUM ('WORKER', 'PROVIDER', 'WORKFLOW', 'ORGANIZATION', 'MISSION');

-- CreateEnum
CREATE TYPE "MetricPeriod" AS ENUM ('HOUR', 'DAY', 'WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "RecommendationKind" AS ENUM ('PROVIDER_SWITCH', 'MODEL_SWITCH', 'PROMPT_REFINEMENT', 'TOOL_PERMISSION', 'MEMORY_TUNING', 'LIMIT_ADJUSTMENT', 'WORKFLOW_STRUCTURE', 'WORKFLOW_PRUNE', 'WORKFLOW_PARALLELISE', 'WORKFLOW_GUARD', 'KNOWLEDGE_MERGE', 'KNOWLEDGE_REFRESH', 'KNOWLEDGE_GAP', 'COST_THRESHOLD', 'CAPACITY');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'APPLIED', 'ROLLED_BACK', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PatternKind" AS ENUM ('PROVIDER_AFFINITY', 'WORKER_COLLABORATION', 'FAILURE_MODE', 'TIMING', 'COST', 'TEMPLATE_PERFORMANCE', 'DOMAIN_STYLE', 'ROI');

-- CreateEnum
CREATE TYPE "LearningEntryKind" AS ENUM ('MISSION_REVIEW', 'OPTIMIZATION', 'PERFORMANCE_TREND', 'DECISION', 'BENCHMARK', 'AB_TEST', 'LESSON');

-- CreateEnum
CREATE TYPE "KnowledgeFinding" AS ENUM ('DUPLICATE', 'NEAR_DUPLICATE', 'OUTDATED', 'UNUSED', 'MERGE_CANDIDATE', 'MISCATEGORISED', 'GAP', 'LOW_CONFIDENCE');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('RUNNING', 'CONCLUDED', 'ABANDONED');

-- CreateTable
CREATE TABLE "mission_reviews" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "outcome" "ReviewOutcome" NOT NULL,
    "successScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completionMs" INTEGER NOT NULL DEFAULT 0,
    "estimatedMs" INTEGER,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estimatedCostUsd" DOUBLE PRECISION,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "taskCount" INTEGER NOT NULL DEFAULT 0,
    "tasksSucceeded" INTEGER NOT NULL DEFAULT 0,
    "tasksFailed" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "humanInterventions" INTEGER NOT NULL DEFAULT 0,
    "humanMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bottlenecks" JSONB NOT NULL DEFAULT '[]',
    "missedOpportunities" JSONB NOT NULL DEFAULT '[]',
    "recommendations" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleSize" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mission_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subject" "MetricSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT NOT NULL DEFAULT '',
    "period" "MetricPeriod" NOT NULL DEFAULT 'DAY',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "successes" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "observedRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgDurationMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "p95DurationMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "avgLatencyMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "retryRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "errorRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costEfficiency" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "RecommendationKind" NOT NULL,
    "subject" "MetricSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "estimatedImpact" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impactSummary" TEXT NOT NULL DEFAULT '',
    "risk" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "riskNotes" TEXT,
    "proposedChange" JSONB NOT NULL DEFAULT '{}',
    "rollback" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PROPOSED',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNotes" TEXT,
    "appliedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "appliedSnapshot" JSONB,
    "supersedesId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "preferredProviderId" TEXT,
    "preferredModel" TEXT,
    "preferenceEvidence" JSONB NOT NULL DEFAULT '{}',
    "executions" INTEGER NOT NULL DEFAULT 0,
    "successes" INTEGER NOT NULL DEFAULT 0,
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgQuality" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgDurationMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgTokens" INTEGER NOT NULL DEFAULT 0,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "toolDenialCount" INTEGER NOT NULL DEFAULT 0,
    "bestPromptStyle" TEXT,
    "failureTypes" JSONB NOT NULL DEFAULT '[]',
    "strengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "weaknesses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastAnalyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detected_patterns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "PatternKind" NOT NULL,
    "signature" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "evidenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "contradictions" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "band" TEXT NOT NULL DEFAULT 'ANECDOTAL',
    "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    "dismissedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detected_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "LearningEntryKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "supersededById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_audits" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "knowledgeId" TEXT NOT NULL,
    "finding" "KnowledgeFinding" NOT NULL,
    "relatedId" TEXT,
    "similarity" DOUBLE PRECISION,
    "detail" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "controlVersionId" TEXT NOT NULL,
    "variantVersionId" TEXT NOT NULL,
    "allocation" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "controlRuns" INTEGER NOT NULL DEFAULT 0,
    "controlSuccesses" INTEGER NOT NULL DEFAULT 0,
    "controlDurationMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "controlCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "variantRuns" INTEGER NOT NULL DEFAULT 0,
    "variantSuccesses" INTEGER NOT NULL DEFAULT 0,
    "variantDurationMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "variantCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'RUNNING',
    "winner" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conclusion" TEXT,
    "minRunsPerArm" INTEGER NOT NULL DEFAULT 20,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concludedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mission_reviews_missionId_key" ON "mission_reviews"("missionId");

-- CreateIndex
CREATE INDEX "mission_reviews_organizationId_idx" ON "mission_reviews"("organizationId");

-- CreateIndex
CREATE INDEX "mission_reviews_organizationId_outcome_idx" ON "mission_reviews"("organizationId", "outcome");

-- CreateIndex
CREATE INDEX "mission_reviews_organizationId_createdAt_idx" ON "mission_reviews"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "performance_snapshots_organizationId_idx" ON "performance_snapshots"("organizationId");

-- CreateIndex
CREATE INDEX "performance_snapshots_organizationId_subject_periodStart_idx" ON "performance_snapshots"("organizationId", "subject", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "performance_snapshots_organizationId_subject_subjectId_peri_key" ON "performance_snapshots"("organizationId", "subject", "subjectId", "period", "periodStart");

-- CreateIndex
CREATE INDEX "recommendations_organizationId_idx" ON "recommendations"("organizationId");

-- CreateIndex
CREATE INDEX "recommendations_organizationId_status_priority_idx" ON "recommendations"("organizationId", "status", "priority");

-- CreateIndex
CREATE INDEX "recommendations_organizationId_subject_subjectId_idx" ON "recommendations"("organizationId", "subject", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "worker_profiles_workerId_key" ON "worker_profiles"("workerId");

-- CreateIndex
CREATE INDEX "worker_profiles_organizationId_idx" ON "worker_profiles"("organizationId");

-- CreateIndex
CREATE INDEX "detected_patterns_organizationId_idx" ON "detected_patterns"("organizationId");

-- CreateIndex
CREATE INDEX "detected_patterns_organizationId_kind_confidence_idx" ON "detected_patterns"("organizationId", "kind", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "detected_patterns_organizationId_signature_key" ON "detected_patterns"("organizationId", "signature");

-- CreateIndex
CREATE INDEX "learning_entries_organizationId_idx" ON "learning_entries"("organizationId");

-- CreateIndex
CREATE INDEX "learning_entries_organizationId_kind_createdAt_idx" ON "learning_entries"("organizationId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "knowledge_audits_organizationId_idx" ON "knowledge_audits"("organizationId");

-- CreateIndex
CREATE INDEX "knowledge_audits_organizationId_finding_resolvedAt_idx" ON "knowledge_audits"("organizationId", "finding", "resolvedAt");

-- CreateIndex
CREATE INDEX "experiments_organizationId_idx" ON "experiments"("organizationId");

-- CreateIndex
CREATE INDEX "experiments_organizationId_status_idx" ON "experiments"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "mission_reviews" ADD CONSTRAINT "mission_reviews_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_reviews" ADD CONSTRAINT "mission_reviews_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detected_patterns" ADD CONSTRAINT "detected_patterns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_entries" ADD CONSTRAINT "learning_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_audits" ADD CONSTRAINT "knowledge_audits_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_audits" ADD CONSTRAINT "knowledge_audits_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "knowledge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
