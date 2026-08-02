import { Module } from '@nestjs/common';
import { MissionsController } from './missions.controller';
import { MissionsService } from './missions.service';
import { MissionOrchestrator } from './orchestrator/mission-orchestrator.service';
import { MissionExecutionController } from './orchestrator/mission-execution.controller';
import { WorkerRuntimeModule } from '../workers/runtime/worker-runtime.module';

@Module({
  imports: [WorkerRuntimeModule],
  controllers: [MissionsController, MissionExecutionController],
  providers: [MissionsService, MissionOrchestrator],
  exports: [MissionsService, MissionOrchestrator],
})
export class MissionsModule {}
