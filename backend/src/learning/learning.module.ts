import { Module } from '@nestjs/common';

import { MissionReviewService } from './mission-review.service';
import { PerformanceAnalyticsService } from './performance-analytics.service';
import { RecommendationService } from './recommendation.service';
import { KnowledgeEvolutionService } from './knowledge-evolution.service';
import { WorkerOptimizerService } from './worker-optimizer.service';
import { WorkflowOptimizerService } from './workflow-optimizer.service';
import { PatternRecognitionService } from './pattern-recognition.service';
import { LearningDashboardService } from './learning-dashboard.service';
import {
  ExperimentController,
  LearningAnalyticsController,
  LearningDashboardController,
  MissionReviewController,
  OptimizerController,
  RecommendationController,
} from './learning.controllers';

/**
 * Phase 5 — the Learning & Optimization Engine.
 *
 * Sits at the top of the stack and depends on nothing above it. Everything
 * it needs, it reads through the repository layer: missions, tasks,
 * execution logs, workflow runs, approvals, knowledge. That direction of
 * dependency is deliberate — the learning engine observes the system, and a
 * system that had to know it was being observed would be one where analysis
 * could change behaviour by accident.
 *
 * The only path back to production is RecommendationService.apply(), and it
 * refuses to run without a human decision.
 */
@Module({
  controllers: [
    MissionReviewController,
    LearningAnalyticsController,
    RecommendationController,
    OptimizerController,
    ExperimentController,
    LearningDashboardController,
  ],
  providers: [
    MissionReviewService,
    PerformanceAnalyticsService,
    RecommendationService,
    KnowledgeEvolutionService,
    WorkerOptimizerService,
    WorkflowOptimizerService,
    PatternRecognitionService,
    LearningDashboardService,
  ],
  exports: [
    MissionReviewService,
    PerformanceAnalyticsService,
    RecommendationService,
    WorkflowOptimizerService,
    LearningDashboardService,
  ],
})
export class LearningModule {}
