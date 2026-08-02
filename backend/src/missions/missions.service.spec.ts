import { BadRequestException } from '@nestjs/common';
import { MissionsService } from './missions.service';

/**
 * Focused on the rules that are easy to get wrong and expensive when they are:
 * the state machine, cycle detection, and derived mission completion.
 */
describe('MissionsService', () => {
  let missions: any;
  let tasks: any;
  let workers: any;
  let events: any;
  let service: MissionsService;

  const mission = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    title: 'Sweep',
    status: 'RUNNING',
    progress: 0,
    ...over,
  });

  beforeEach(() => {
    missions = {
      create: jest.fn().mockResolvedValue(mission({ status: 'DRAFT' })),
      findByIdOrFail: jest.fn().mockResolvedValue(mission()),
      findWithTasks: jest.fn(),
      update: jest.fn().mockImplementation((_id, data) => Promise.resolve(mission(data))),
      count: jest.fn().mockResolvedValue(0),
      remove: jest.fn(),
      paginate: jest.fn(),
    };
    tasks = {
      create: jest.fn().mockImplementation((d) => Promise.resolve({ id: `t${Math.random()}`, ...d })),
      findByMission: jest.fn().mockResolvedValue([]),
      findByIdOrFail: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
      findRunnable: jest.fn(),
    };
    workers = { findByIdOrFail: jest.fn().mockResolvedValue({ id: 'w1' }) };
    events = { publish: jest.fn().mockResolvedValue(undefined) };

    service = new MissionsService(missions, tasks, workers, events);
  });

  describe('task graph validation', () => {
    it('rejects a direct cycle', async () => {
      await expect(
        service.create({
          title: 'Cyclic',
          objective: 'x',
          tasks: [
            { title: 'A', dependsOn: ['1'] },
            { title: 'B', dependsOn: ['0'] },
          ],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a longer cycle', async () => {
      await expect(
        service.create({
          title: 'Cyclic',
          objective: 'x',
          tasks: [
            { title: 'A', dependsOn: ['2'] },
            { title: 'B', dependsOn: ['0'] },
            { title: 'C', dependsOn: ['1'] },
          ],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a diamond, which is acyclic despite the shared ancestor', async () => {
      await expect(
        service.create({
          title: 'Diamond',
          objective: 'x',
          tasks: [
            { title: 'root' },
            { title: 'left', dependsOn: ['0'] },
            { title: 'right', dependsOn: ['0'] },
            { title: 'join', dependsOn: ['1', '2'] },
          ],
        } as never),
      ).resolves.toBeDefined();
    });
  });

  describe('state machine', () => {
    it('refuses to start a completed mission', async () => {
      missions.findByIdOrFail.mockResolvedValue(mission({ status: 'COMPLETED' }));
      await expect(service.start('m1')).rejects.toThrow(/cannot move to QUEUED/);
    });

    it('refuses to start a mission with no tasks', async () => {
      missions.findByIdOrFail.mockResolvedValue(mission({ status: 'DRAFT' }));
      tasks.count.mockResolvedValue(0);
      await expect(service.start('m1')).rejects.toThrow(/at least one task/);
    });

    it('starts a draft mission that has tasks', async () => {
      missions.findByIdOrFail.mockResolvedValue(mission({ status: 'DRAFT' }));
      tasks.count.mockResolvedValue(2);

      await service.start('m1');

      expect(missions.update).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({ status: 'RUNNING' }),
      );
      expect(events.publish).toHaveBeenCalledWith('mission.started', expect.anything());
    });

    it('refuses to edit the objective of a running mission', async () => {
      await expect(service.update('m1', { objective: 'new' } as never)).rejects.toThrow(
        /Pause the mission/,
      );
    });

    it('allows editing a paused mission', async () => {
      missions.findByIdOrFail.mockResolvedValue(mission({ status: 'PAUSED' }));
      await expect(
        service.update('m1', { objective: 'new' } as never),
      ).resolves.toBeDefined();
    });
  });

  describe('derived progress', () => {
    const withTasks = (statuses: string[]) =>
      tasks.findByMission.mockResolvedValue(
        statuses.map((status, i) => ({ id: `t${i}`, missionId: 'm1', status, attempts: 0 })),
      );

    it('completes the mission when the final task completes', async () => {
      tasks.findByIdOrFail.mockResolvedValue({ id: 't0', missionId: 'm1', attempts: 0 });
      tasks.update.mockResolvedValue({ id: 't0', status: 'COMPLETED' });
      withTasks(['COMPLETED', 'COMPLETED']);

      await service.updateTask('m1', 't0', { status: 'COMPLETED' } as never);

      expect(missions.update).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({ status: 'COMPLETED', progress: 100 }),
      );
      expect(events.publish).toHaveBeenCalledWith('mission.completed', expect.anything());
    });

    it('reports partial progress without completing', async () => {
      tasks.findByIdOrFail.mockResolvedValue({ id: 't0', missionId: 'm1', attempts: 0 });
      tasks.update.mockResolvedValue({ id: 't0', status: 'COMPLETED' });
      withTasks(['COMPLETED', 'PENDING', 'PENDING', 'PENDING']);

      await service.updateTask('m1', 't0', { status: 'COMPLETED' } as never);

      expect(missions.update).toHaveBeenLastCalledWith('m1', { progress: 25 });
    });

    it('fails the mission when no task can still finish', async () => {
      tasks.findByIdOrFail.mockResolvedValue({ id: 't1', missionId: 'm1', attempts: 0 });
      tasks.update.mockResolvedValue({ id: 't1', status: 'FAILED' });
      withTasks(['COMPLETED', 'FAILED']);

      await service.updateTask('m1', 't1', { status: 'FAILED' } as never);

      expect(missions.update).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({ status: 'FAILED' }),
      );
      expect(events.publish).toHaveBeenCalledWith('mission.failed', expect.anything());
    });

    it('rejects updating a task that belongs to another mission', async () => {
      tasks.findByIdOrFail.mockResolvedValue({ id: 't9', missionId: 'other', attempts: 0 });
      await expect(
        service.updateTask('m1', 't9', { status: 'COMPLETED' } as never),
      ).rejects.toThrow(/does not belong/);
    });
  });
});
