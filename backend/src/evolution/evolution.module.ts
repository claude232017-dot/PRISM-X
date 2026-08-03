import { Module } from '@nestjs/common';
import { WorkerRuntimeModule } from '../workers/runtime/worker-runtime.module';
import { LearningModule } from '../learning/learning.module';

import { CandidateService } from './candidate.service';
import { ExperimentService } from './experiment.service';
import { BenchmarkService } from './benchmark.service';
import { VersionService } from './version.service';
import { DeploymentService } from './deployment.service';
import { EvolutionPolicyService } from './policy.service';
import { PlanningEvolutionService } from './planning-evolution.service';
import { EvolutionDashboardService } from './evolution-dashboard.service';
import {
  CandidateController,
  ConstitutionController,
  DeploymentController,
  EvolutionDashboardController,
  EvolutionExperimentController,
  EvolutionPolicyController,
  PlanningEvolutionController,
  VersionController,
} from './evolution.controllers';

/**
 * Phase 6 — the Evolution Engine.
 *
 * Sits at the very top of the stack. It reads what Phase 5 concluded and is
 * the only thing in the system that writes changes back to workers,
 * workflows and providers on the strength of that analysis — through exactly
 * one method, guarded by the Constitution.
 *
 * It depends on the worker runtime because benchmarking a candidate means
 * actually running it, and on the learning module because candidates are
 * promoted from recommendations. Nothing depends on it in return: no part of
 * PRISM-X needs to know it can be evolved, which is what keeps evolution
 * from becoming a thing every other module has to reason about.
 */
@Module({
  imports: [WorkerRuntimeModule, LearningModule],
  controllers: [
    ConstitutionController,
    CandidateController,
    EvolutionExperimentController,
    VersionController,
    DeploymentController,
    EvolutionPolicyController,
    PlanningEvolutionController,
    EvolutionDashboardController,
  ],
  providers: [
    CandidateService,
    ExperimentService,
    BenchmarkService,
    VersionService,
    DeploymentService,
    EvolutionPolicyService,
    PlanningEvolutionService,
    EvolutionDashboardService,
  ],
  exports: [
    CandidateService,
    DeploymentService,
    EvolutionPolicyService,
    BenchmarkService,
    VersionService,
  ],
})
export class EvolutionModule {}
