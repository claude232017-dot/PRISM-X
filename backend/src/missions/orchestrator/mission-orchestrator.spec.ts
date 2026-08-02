import { BadRequestException } from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import {
  MISSION_TRANSITIONS,
  MissionOrchestrator,
} from './mission-orchestrator.service';

/**
 * The state machine and the scheduler are the two places where a subtle bug
 * would be expensive and hard to notice — a mission stuck RUNNING forever, or
 * a task starting before its dependency finished.
 */
describe('MissionOrchestrator', () => {
  const build = () => {
    const missions = {
      findByIdOrFail: jest.fn(),
      update: jest.fn().mockImplementation((id, data) => Promise.resolve({ id, ...data })),
    };
    const tasks = {
      findByMission: jest.fn().mockResolvedValue([]),
      findRunnable: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      findByIdOrFail: jest.fn(),
    };
    const workers = { findMany: jest.fn().mockResolvedValue([]) };
    const runtime = { execute: jest.fn() };
    const executionLogs = {
      summarize: jest.fn().mockResolvedValue({ costUsd: 0, totalTokens: 0 }),
    };
    const events = { publish: jest.fn().mockResolvedValue(undefined) };

    const orchestrator = new MissionOrchestrator(
      missions as never,
      tasks as never,
      workers as never,
      runtime as never,
      executionLogs as never,
      events as never,
    );
    return { orchestrator, missions, tasks, workers, runtime, events };
  };

  describe('lifecycle', () => {
    it('encodes the full Phase 2 lifecycle', () => {
      expect(MISSION_TRANSITIONS.DRAFT).toContain(MissionStatus.QUEUED);
      expect(MISSION_TRANSITIONS.QUEUED).toContain(MissionStatus.PLANNING);
      expect(MISSION_TRANSITIONS.PLANNING).toContain(MissionStatus.RUNNING);
      expect(MISSION_TRANSITIONS.RUNNING).toContain(MissionStatus.WAITING);
      expect(MISSION_TRANSITIONS.WAITING).toContain(MissionStatus.RUNNING);
      expect(MISSION_TRANSITIONS.COMPLETED).toContain(MissionStatus.ARCHIVED);
    });

    it('treats ARCHIVED as terminal', () => {
      expect(MISSION_TRANSITIONS.ARCHIVED).toHaveLength(0);
    });

    it('allows a failed mission to be re-queued but not resumed directly', () => {
      expect(MISSION_TRANSITIONS.FAILED).toContain(MissionStatus.QUEUED);
      expect(MISSION_TRANSITIONS.FAILED).not.toContain(MissionStatus.RUNNING);
    });

    it('names the permitted transitions when rejecting one', () => {
      const { orchestrator } = build();

      // ARCHIVED is the only genuinely terminal state; COMPLETED still has
      // somewhere to go, so its rejection lists that option instead.
      expect(() =>
        orchestrator.assertTransition(MissionStatus.ARCHIVED, MissionStatus.RUNNING),
      ).toThrow(/terminal state/);

      expect(() =>
        orchestrator.assertTransition(MissionStatus.COMPLETED, MissionStatus.RUNNING),
      ).toThrow(/Allowed: ARCHIVED/);

      expect(() =>
        orchestrator.assertTransition(MissionStatus.DRAFT, MissionStatus.COMPLETED),
      ).toThrow(/Allowed: QUEUED, CANCELLED/);
    });

    it('every status has an entry, so no state is unreachable by omission', () => {
      for (const status of Object.values(MissionStatus)) {
        expect(MISSION_TRANSITIONS[status]).toBeDefined();
      }
    });
  });

  describe('planning', () => {
    it('refuses to plan a mission with no tasks', async () => {
      const { orchestrator, missions, tasks } = build();
      missions.findByIdOrFail.mockResolvedValue({ id: 'm1', status: MissionStatus.QUEUED });
      tasks.findByMission.mockResolvedValue([]);

      await expect(orchestrator.plan('m1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to plan when no worker is active', async () => {
      const { orchestrator, missions, tasks, workers } = build();
      missions.findByIdOrFail.mockResolvedValue({ id: 'm1', status: MissionStatus.QUEUED });
      tasks.findByMission.mockResolvedValue([{ id: 't1', dependsOn: [], title: 'x' }]);
      workers.findMany.mockResolvedValue([]);

      await expect(orchestrator.plan('m1')).rejects.toThrow(/ACTIVE worker/);
    });

    it('queues a DRAFT mission on the way into planning', async () => {
      const { orchestrator, missions, tasks, workers } = build();
      missions.findByIdOrFail.mockResolvedValue({ id: 'm1', status: MissionStatus.DRAFT });
      tasks.findByMission.mockResolvedValue([
        { id: 't1', dependsOn: [], title: 'Analyse pricing', workerId: null },
      ]);
      workers.findMany.mockResolvedValue([
        { id: 'w1', role: 'analyst', skills: [], capabilities: [], fitness: 0 },
      ]);

      await orchestrator.plan('m1');

      const statuses = missions.update.mock.calls.map((c) => c[1].status).filter(Boolean);
      expect(statuses).toEqual([MissionStatus.QUEUED, MissionStatus.PLANNING]);
    });

    it('assigns the best-matching worker by role and skill', async () => {
      const { orchestrator, missions, tasks, workers } = build();
      missions.findByIdOrFail.mockResolvedValue({ id: 'm1', status: MissionStatus.QUEUED });
      tasks.findByMission.mockResolvedValue([
        { id: 't1', dependsOn: [], title: 'Run a pricing analysis', workerId: null },
      ]);
      workers.findMany.mockResolvedValue([
        { id: 'writer', role: 'writer', skills: [], capabilities: [], fitness: 0 },
        { id: 'analyst', role: 'analyst', skills: ['pricing'], capabilities: [], fitness: 0 },
      ]);

      await orchestrator.plan('m1');

      expect(tasks.update).toHaveBeenCalledWith('t1', { workerId: 'analyst' });
    });

    it('groups tasks into dependency waves', async () => {
      const { orchestrator, missions, tasks, workers } = build();
      missions.findByIdOrFail.mockResolvedValue({ id: 'm1', status: MissionStatus.QUEUED });
      const graph = [
        { id: 'a', dependsOn: [], title: 'a', workerId: 'w1' },
        { id: 'b', dependsOn: ['a'], title: 'b', workerId: 'w1' },
        { id: 'c', dependsOn: ['a'], title: 'c', workerId: 'w1' },
        { id: 'd', dependsOn: ['b', 'c'], title: 'd', workerId: 'w1' },
      ];
      tasks.findByMission.mockResolvedValue(graph);
      workers.findMany.mockResolvedValue([
        { id: 'w1', role: 'any', skills: [], capabilities: [], fitness: 0 },
      ]);

      await orchestrator.plan('m1');

      const planCall = missions.update.mock.calls.find((c) => c[1].plan);
      const waves = planCall[1].plan.waves as { tasks: unknown[] }[];
      // a | b,c | d — the diamond collapses into three waves.
      expect(waves.map((w) => w.tasks.length)).toEqual([1, 2, 1]);
    });
  });

  describe('control operations', () => {
    it('skips never-started tasks when a mission is cancelled', async () => {
      const { orchestrator, missions, tasks } = build();
      missions.findByIdOrFail.mockResolvedValue({ id: 'm1', status: MissionStatus.RUNNING });
      tasks.findByMission.mockResolvedValue([
        { id: 't1', status: 'PENDING' },
        { id: 't2', status: 'COMPLETED' },
      ]);

      await orchestrator.cancel('m1');

      // Leaving them PENDING would make a cancelled mission look resumable.
      expect(tasks.update).toHaveBeenCalledWith('t1', { status: 'SKIPPED' });
      expect(tasks.update).not.toHaveBeenCalledWith('t2', expect.anything());
    });

    it('refuses to retry beyond the mission’s limit', async () => {
      const { orchestrator, missions } = build();
      missions.findByIdOrFail.mockResolvedValue({
        id: 'm1',
        status: MissionStatus.FAILED,
        retryCount: 2,
        maxRetries: 2,
      });

      await expect(orchestrator.retry('m1')).rejects.toThrow(/limit is 2/);
    });

    it('resets failed tasks when retrying', async () => {
      const { orchestrator, missions, tasks } = build();
      missions.findByIdOrFail.mockResolvedValue({
        id: 'm1',
        status: MissionStatus.FAILED,
        retryCount: 0,
        maxRetries: 2,
      });
      tasks.findByMission.mockResolvedValue([
        { id: 't1', status: 'FAILED' },
        { id: 't2', status: 'COMPLETED' },
      ]);

      await orchestrator.retry('m1');

      expect(tasks.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ status: 'PENDING', attempts: 0, error: null }),
      );
      expect(tasks.update).toHaveBeenCalledTimes(1);
    });

    it('refuses to resume a mission that is not paused or waiting', async () => {
      const { orchestrator, missions } = build();
      missions.findByIdOrFail.mockResolvedValue({ id: 'm1', status: MissionStatus.RUNNING });
      await expect(orchestrator.resume('m1')).rejects.toThrow(/PAUSED or WAITING/);
    });
  });
});
