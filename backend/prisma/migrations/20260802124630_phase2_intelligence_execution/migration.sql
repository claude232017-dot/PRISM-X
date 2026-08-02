-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('SHORT_TERM', 'LONG_TERM');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'BUDGET_EXCEEDED');

-- CreateEnum
CREATE TYPE "ToolStatus" AS ENUM ('SUCCESS', 'FAILED', 'DENIED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MissionStatus" ADD VALUE 'PLANNING';
ALTER TYPE "MissionStatus" ADD VALUE 'WAITING';
ALTER TYPE "MissionStatus" ADD VALUE 'ARCHIVED';

-- AlterEnum
ALTER TYPE "ProviderKind" ADD VALUE 'OLLAMA';

-- AlterTable
ALTER TABLE "missions" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "maxRetries" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "plan" JSONB,
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "totalTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "waitReason" TEXT;

-- AlterTable
ALTER TABLE "providers" ADD COLUMN     "avgLatencyMs" INTEGER,
ADD COLUMN     "cooldownUntil" TIMESTAMP(3),
ADD COLUMN     "defaultModel" TEXT,
ADD COLUMN     "failedRequests" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rateLimitRpm" INTEGER,
ADD COLUMN     "rateLimitTpm" INTEGER,
ADD COLUMN     "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "totalRequests" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalTokens" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "estimatedCostUsd" DOUBLE PRECISION,
ADD COLUMN     "estimatedSeconds" INTEGER,
ADD COLUMN     "maxRetries" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "output" TEXT,
ADD COLUMN     "tokensUsed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "workers" ADD COLUMN     "costLimitUsd" DOUBLE PRECISION,
ADD COLUMN     "defaultModel" TEXT,
ADD COLUMN     "maxIterations" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "maxTokens" INTEGER NOT NULL DEFAULT 4096,
ADD COLUMN     "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "systemPrompt" TEXT,
ADD COLUMN     "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
ADD COLUMN     "timeoutMs" INTEGER NOT NULL DEFAULT 120000,
ADD COLUMN     "toolPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "type" "MemoryType" NOT NULL DEFAULT 'SHORT_TERM',
    "content" TEXT NOT NULL,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "missionId" TEXT,
    "taskId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workerId" TEXT,
    "missionId" TEXT,
    "taskId" TEXT,
    "providerId" TEXT,
    "providerKind" "ProviderKind",
    "model" TEXT,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "prompt" TEXT,
    "outputSummary" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_calls" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "executionLogId" TEXT,
    "workerId" TEXT,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "status" "ToolStatus" NOT NULL DEFAULT 'SUCCESS',
    "error" TEXT,
    "denied" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_daily" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "providerId" TEXT,
    "providerKind" "ProviderKind",
    "model" TEXT,
    "workerId" TEXT,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "failedRequests" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMsTotal" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memories_organizationId_idx" ON "memories"("organizationId");

-- CreateIndex
CREATE INDEX "memories_workerId_type_idx" ON "memories"("workerId", "type");

-- CreateIndex
CREATE INDEX "memories_organizationId_expiresAt_idx" ON "memories"("organizationId", "expiresAt");

-- CreateIndex
CREATE INDEX "execution_logs_organizationId_idx" ON "execution_logs"("organizationId");

-- CreateIndex
CREATE INDEX "execution_logs_organizationId_startedAt_idx" ON "execution_logs"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "execution_logs_missionId_idx" ON "execution_logs"("missionId");

-- CreateIndex
CREATE INDEX "execution_logs_workerId_idx" ON "execution_logs"("workerId");

-- CreateIndex
CREATE INDEX "tool_calls_organizationId_idx" ON "tool_calls"("organizationId");

-- CreateIndex
CREATE INDEX "tool_calls_organizationId_tool_idx" ON "tool_calls"("organizationId", "tool");

-- CreateIndex
CREATE INDEX "usage_daily_organizationId_day_idx" ON "usage_daily"("organizationId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "usage_daily_organizationId_day_providerId_model_workerId_key" ON "usage_daily"("organizationId", "day", "providerId", "model", "workerId");

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_executionLogId_fkey" FOREIGN KEY ("executionLogId") REFERENCES "execution_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
