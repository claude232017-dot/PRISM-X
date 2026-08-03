import { Module } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module';
import { ToolsModule } from '../tools/tools.module';
import { WorkerRuntimeModule } from '../workers/runtime/worker-runtime.module';

import { NodeScheduler } from './node-scheduler.service';
import { DistributedExecutionService } from './distributed-execution.service';
import { QueueCoordinator } from './queue-coordinator.service';
import { FailoverService } from './failover.service';
import { ClusterMonitorService } from './cluster-monitor.service';
import { MemorySyncService } from './memory-sync.service';
import { FederationService } from './federation.service';
import { DistributedWorkerRouter } from './worker-router.service';
import {
  DistributedController,
  DistributedMemoryController,
  FederationController,
  NodeAgentController,
  NodesController,
} from './distributed.controllers';

/**
 * Phase 4 — distributed intelligence.
 *
 * Sits above both the fleet (NodesModule) and the execution layer
 * (WorkerRuntimeModule) and depends on each in one direction only. Nothing
 * below it knows this module exists; the single seam back down is the router
 * callback that DistributedWorkerRouter installs on the worker runtime at
 * startup, which is what keeps "the same call, now possibly on another
 * machine" from becoming a dependency cycle.
 */
@Module({
  imports: [NodesModule, ToolsModule, WorkerRuntimeModule],
  controllers: [
    NodesController,
    NodeAgentController,
    DistributedController,
    DistributedMemoryController,
    FederationController,
  ],
  providers: [
    NodeScheduler,
    DistributedExecutionService,
    QueueCoordinator,
    FailoverService,
    ClusterMonitorService,
    MemorySyncService,
    FederationService,
    DistributedWorkerRouter,
  ],
  exports: [
    NodeScheduler,
    DistributedExecutionService,
    QueueCoordinator,
    ClusterMonitorService,
    MemorySyncService,
    FederationService,
  ],
})
export class DistributedModule {}
