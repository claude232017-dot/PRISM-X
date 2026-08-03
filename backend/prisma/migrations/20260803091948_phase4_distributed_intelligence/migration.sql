-- CreateEnum
CREATE TYPE "NodeType" AS ENUM ('LOCAL_MACHINE', 'HOME_SERVER', 'CLOUD_VPS', 'DEDICATED_AI_SERVER', 'EDGE_DEVICE', 'DEVELOPMENT_MACHINE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('PENDING', 'ONLINE', 'DEGRADED', 'OFFLINE', 'DRAINING', 'QUARANTINED', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "NodeTrust" AS ENUM ('UNVERIFIED', 'TRUSTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "NodeKeyStatus" AS ENUM ('ACTIVE', 'RETIRING', 'REVOKED');

-- CreateEnum
CREATE TYPE "CapabilityKind" AS ENUM ('PROVIDER', 'MODEL', 'TOOL', 'EXTENSION', 'RUNTIME', 'HARDWARE');

-- CreateEnum
CREATE TYPE "DistributedQueue" AS ENUM ('INCOMING', 'ACTIVE', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DistributedTaskStatus" AS ENUM ('QUEUED', 'ASSIGNED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED', 'MIGRATING');

-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('LOCAL', 'SHARED', 'CACHED', 'GLOBAL');

-- CreateEnum
CREATE TYPE "SyncOpKind" AS ENUM ('PUT', 'DELETE');

-- CreateEnum
CREATE TYPE "SyncOpStatus" AS ENUM ('PENDING', 'APPLIED', 'CONFLICT', 'SUPERSEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "FederationStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED');

-- AlterTable
ALTER TABLE "workers" ADD COLUMN     "nodeRequirements" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "preferredNodeId" TEXT;

-- CreateTable
CREATE TABLE "nodes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "NodeType" NOT NULL DEFAULT 'CUSTOM',
    "status" "NodeStatus" NOT NULL DEFAULT 'PENDING',
    "endpointUrl" TEXT,
    "isLocal" BOOLEAN NOT NULL DEFAULT false,
    "region" TEXT NOT NULL DEFAULT 'default',
    "version" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cpuCores" INTEGER NOT NULL DEFAULT 0,
    "cpuModel" TEXT,
    "memoryMb" INTEGER NOT NULL DEFAULT 0,
    "diskMb" INTEGER NOT NULL DEFAULT 0,
    "gpuCount" INTEGER NOT NULL DEFAULT 0,
    "gpuModel" TEXT,
    "gpuMemoryMb" INTEGER NOT NULL DEFAULT 0,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 4,
    "activeTasks" INTEGER NOT NULL DEFAULT 0,
    "queueDepth" INTEGER NOT NULL DEFAULT 0,
    "cpuUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memoryUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "diskUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gpuUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uptimeSeconds" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "healthScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costPerHourUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastSeenIp" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trust" "NodeTrust" NOT NULL DEFAULT 'UNVERIFIED',
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "allowRemoteExecution" BOOLEAN NOT NULL DEFAULT true,
    "drainReason" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "quarantinedUntil" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_capabilities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "kind" "CapabilityKind" NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "version" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_heartbeats" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" "NodeStatus" NOT NULL,
    "cpuUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memoryUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "diskUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gpuUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "activeTasks" INTEGER NOT NULL DEFAULT 0,
    "queueDepth" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uptimeSeconds" INTEGER NOT NULL DEFAULT 0,
    "healthScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL DEFAULT '{}',
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "secretHash" TEXT NOT NULL,
    "status" "NodeKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "node_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distributed_tasks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "queue" "DistributedQueue" NOT NULL DEFAULT 'INCOMING',
    "status" "DistributedTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "requirements" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "nodeId" TEXT,
    "originNodeId" TEXT,
    "previousNodeId" TEXT,
    "migrations" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "idempotencyKey" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workerId" TEXT,
    "missionId" TEXT,
    "taskId" TEXT,
    "workflowRunId" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "distributed_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_shards" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scope" "MemoryScope" NOT NULL DEFAULT 'LOCAL',
    "namespace" TEXT NOT NULL DEFAULT 'default',
    "key" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL DEFAULT '',
    "value" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "checksum" TEXT NOT NULL DEFAULT '',
    "vectorClock" JSONB NOT NULL DEFAULT '{}',
    "ownerNodeId" TEXT,
    "lastWriterNodeId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "memory_shards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_sync_ops" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sequence" SERIAL NOT NULL,
    "shardId" TEXT,
    "scope" "MemoryScope" NOT NULL,
    "namespace" TEXT NOT NULL DEFAULT 'default',
    "key" TEXT NOT NULL,
    "op" "SyncOpKind" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "nodeId" TEXT NOT NULL DEFAULT '',
    "status" "SyncOpStatus" NOT NULL DEFAULT 'PENDING',
    "conflictWithId" TEXT,
    "resolution" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_sync_ops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_sync_states" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "scope" "MemoryScope" NOT NULL,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMP(3),
    "pendingOps" INTEGER NOT NULL DEFAULT 0,
    "recovering" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federation_grants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "peerOrganizationId" TEXT NOT NULL,
    "name" TEXT,
    "status" "FederationStatus" NOT NULL DEFAULT 'PENDING',
    "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedNodeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxConcurrentTasks" INTEGER NOT NULL DEFAULT 1,
    "activeTasks" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "revokedById" TEXT,
    "terms" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "federation_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nodes_organizationId_idx" ON "nodes"("organizationId");

-- CreateIndex
CREATE INDEX "nodes_organizationId_status_idx" ON "nodes"("organizationId", "status");

-- CreateIndex
CREATE INDEX "nodes_organizationId_lastHeartbeatAt_idx" ON "nodes"("organizationId", "lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_organizationId_slug_key" ON "nodes"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "node_capabilities_organizationId_idx" ON "node_capabilities"("organizationId");

-- CreateIndex
CREATE INDEX "node_capabilities_organizationId_kind_key_idx" ON "node_capabilities"("organizationId", "kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "node_capabilities_nodeId_kind_key_key" ON "node_capabilities"("nodeId", "kind", "key");

-- CreateIndex
CREATE INDEX "node_heartbeats_organizationId_idx" ON "node_heartbeats"("organizationId");

-- CreateIndex
CREATE INDEX "node_heartbeats_nodeId_reportedAt_idx" ON "node_heartbeats"("nodeId", "reportedAt");

-- CreateIndex
CREATE INDEX "node_keys_organizationId_idx" ON "node_keys"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "node_keys_nodeId_version_key" ON "node_keys"("nodeId", "version");

-- CreateIndex
CREATE INDEX "distributed_tasks_organizationId_idx" ON "distributed_tasks"("organizationId");

-- CreateIndex
CREATE INDEX "distributed_tasks_organizationId_queue_idx" ON "distributed_tasks"("organizationId", "queue");

-- CreateIndex
CREATE INDEX "distributed_tasks_organizationId_status_availableAt_idx" ON "distributed_tasks"("organizationId", "status", "availableAt");

-- CreateIndex
CREATE INDEX "distributed_tasks_nodeId_status_idx" ON "distributed_tasks"("nodeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "distributed_tasks_organizationId_idempotencyKey_key" ON "distributed_tasks"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "memory_shards_organizationId_idx" ON "memory_shards"("organizationId");

-- CreateIndex
CREATE INDEX "memory_shards_organizationId_scope_updatedAt_idx" ON "memory_shards"("organizationId", "scope", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "memory_shards_organizationId_scope_namespace_nodeId_key_key" ON "memory_shards"("organizationId", "scope", "namespace", "nodeId", "key");

-- CreateIndex
CREATE INDEX "memory_sync_ops_organizationId_idx" ON "memory_sync_ops"("organizationId");

-- CreateIndex
CREATE INDEX "memory_sync_ops_organizationId_sequence_idx" ON "memory_sync_ops"("organizationId", "sequence");

-- CreateIndex
CREATE INDEX "memory_sync_ops_organizationId_status_idx" ON "memory_sync_ops"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "memory_sync_ops_sequence_key" ON "memory_sync_ops"("sequence");

-- CreateIndex
CREATE INDEX "node_sync_states_organizationId_idx" ON "node_sync_states"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "node_sync_states_nodeId_scope_key" ON "node_sync_states"("nodeId", "scope");

-- CreateIndex
CREATE INDEX "federation_grants_organizationId_idx" ON "federation_grants"("organizationId");

-- CreateIndex
CREATE INDEX "federation_grants_peerOrganizationId_status_idx" ON "federation_grants"("peerOrganizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "federation_grants_organizationId_peerOrganizationId_key" ON "federation_grants"("organizationId", "peerOrganizationId");

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_capabilities" ADD CONSTRAINT "node_capabilities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_capabilities" ADD CONSTRAINT "node_capabilities_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_heartbeats" ADD CONSTRAINT "node_heartbeats_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_heartbeats" ADD CONSTRAINT "node_heartbeats_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_keys" ADD CONSTRAINT "node_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_keys" ADD CONSTRAINT "node_keys_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributed_tasks" ADD CONSTRAINT "distributed_tasks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributed_tasks" ADD CONSTRAINT "distributed_tasks_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_shards" ADD CONSTRAINT "memory_shards_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_shards" ADD CONSTRAINT "memory_shards_ownerNodeId_fkey" FOREIGN KEY ("ownerNodeId") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_sync_ops" ADD CONSTRAINT "memory_sync_ops_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_sync_states" ADD CONSTRAINT "node_sync_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_sync_states" ADD CONSTRAINT "node_sync_states_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federation_grants" ADD CONSTRAINT "federation_grants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federation_grants" ADD CONSTRAINT "federation_grants_peerOrganizationId_fkey" FOREIGN KEY ("peerOrganizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
