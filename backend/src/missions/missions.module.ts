import { Module } from '@nestjs/common';
import { MissionsController } from './missions.controller';
import { MissionsService } from './missions.service';
import { MissionOrchestrator } from './orchestrator/mission-orchestrator.service';
import { MissionExecutionController } from './orchestrator/mission-execution.controller';
import { MissionQueueService } from './orchestrator/mission-queue.service';
import { WorkerRuntimeModule } from '../workers/runtime/worker-runtime.module';
import { QueuesModule } from '../queues/queues.module';

/**
 * `QueuesModule` is imported, not the other way round. The queue layer holds
 * the connection, the retry policy and the worker; the processor that knows
 * what a mission *is* is registered into it from here, so the dependency
 * points down and the queue module stays ignorant of the orchestrator.
 */
@Module({
  imports: [WorkerRuntimeModule, QueuesModule],
  controllers: [MissionsController, MissionExecutionController],
  providers: [MissionsService, MissionOrchestrator, MissionQueueService],
  exports: [MissionsService, MissionOrchestrator, MissionQueueService],
})
export class MissionsModule {}
