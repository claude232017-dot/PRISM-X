import { MemoryType } from '@prisma/client';
import { MemoryService } from './memory.service';
import { MemoryRepository } from '../database/repositories/execution.repositories';
import { EventBusService } from '../events/event-bus.service';

const makeMemory = (over: Partial<Record<string, unknown>> = {}) => ({
  id: `m${Math.random()}`,
  workerId: 'w1',
  type: MemoryType.SHORT_TERM,
  content: 'Acme raised prices twelve percent',
  tags: [] as string[],
  importance: 0.5,
  accessCount: 0,
  createdAt: new Date(),
  ...over,
});

describe('MemoryService', () => {
  let repo: jest.Mocked<Partial<MemoryRepository>>;
  let events: { publish: jest.Mock };
  let service: MemoryService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockImplementation((d) => Promise.resolve({ id: 'new', ...d })),
      findLive: jest.fn().mockResolvedValue([]),
      findCandidates: jest.fn().mockResolvedValue([]),
      touchMany: jest.fn().mockResolvedValue(undefined),
      pruneExpired: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({}),
      countByType: jest.fn().mockResolvedValue(0),
    } as never;
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new MemoryService(
      repo as unknown as MemoryRepository,
      events as unknown as EventBusService,
    );
  });

  describe('writing', () => {
    it('gives short-term memories an expiry', async () => {
      await service.remember({ workerId: 'w1', content: 'x' });
      const data = (repo.create as jest.Mock).mock.calls[0][0];
      expect(data.type).toBe(MemoryType.SHORT_TERM);
      expect(data.expiresAt).toBeInstanceOf(Date);
    });

    it('leaves long-term memories without an expiry', async () => {
      await service.remember({
        workerId: 'w1',
        content: 'x',
        type: MemoryType.LONG_TERM,
      });
      expect((repo.create as jest.Mock).mock.calls[0][0].expiresAt).toBeNull();
    });

    it('clamps importance into 0..1', async () => {
      await service.remember({ workerId: 'w1', content: 'x', importance: 5 });
      expect((repo.create as jest.Mock).mock.calls[0][0].importance).toBe(1);

      await service.remember({ workerId: 'w1', content: 'y', importance: -3 });
      expect((repo.create as jest.Mock).mock.calls[1][0].importance).toBe(0);
    });

    it('normalises and de-duplicates tags', async () => {
      await service.remember({
        workerId: 'w1',
        content: 'x',
        tags: ['Pricing', 'pricing ', 'ACME'],
      });
      expect((repo.create as jest.Mock).mock.calls[0][0].tags).toEqual(['pricing', 'acme']);
    });

    it('weights a failed execution above a successful one', async () => {
      await service.rememberExecution({
        workerId: 'w1',
        summary: 'ok',
        succeeded: true,
      });
      await service.rememberExecution({
        workerId: 'w1',
        summary: 'broke',
        succeeded: false,
      });

      const [success, failure] = (repo.create as jest.Mock).mock.calls.map((c) => c[0]);
      // A failure carries the information that changes future behaviour.
      expect(failure.importance).toBeGreaterThan(success.importance);
    });
  });

  describe('recall ranking', () => {
    it('ranks a keyword match above an unrelated memory', async () => {
      (repo.findCandidates as jest.Mock).mockResolvedValue([
        makeMemory({ id: 'unrelated', content: 'The team prefers oat milk' }),
        makeMemory({ id: 'relevant', content: 'Acme raised prices twelve percent' }),
      ]);

      const recalled = await service.recall({ workerId: 'w1', query: 'acme prices' });
      expect(recalled[0].memory.id).toBe('relevant');
    });

    it('ranks a more important memory above a less important one, all else equal', async () => {
      (repo.findLive as jest.Mock).mockResolvedValue([
        makeMemory({ id: 'low', importance: 0.1 }),
        makeMemory({ id: 'high', importance: 0.9 }),
      ]);

      const recalled = await service.recall({ workerId: 'w1' });
      expect(recalled[0].memory.id).toBe('high');
    });

    it('decays old memories relative to recent ones', async () => {
      const old = new Date(Date.now() - 60 * 86_400_000);
      (repo.findLive as jest.Mock).mockResolvedValue([
        makeMemory({ id: 'old', createdAt: old }),
        makeMemory({ id: 'fresh', createdAt: new Date() }),
      ]);

      const recalled = await service.recall({ workerId: 'w1' });
      expect(recalled[0].memory.id).toBe('fresh');
    });

    it('lets long-term memories resist recency decay', async () => {
      const old = new Date(Date.now() - 60 * 86_400_000);
      (repo.findLive as jest.Mock).mockResolvedValue([
        makeMemory({ id: 'oldLong', createdAt: old, type: MemoryType.LONG_TERM }),
        makeMemory({ id: 'oldShort', createdAt: old, type: MemoryType.SHORT_TERM }),
      ]);

      const recalled = await service.recall({ workerId: 'w1' });
      const long = recalled.find((r) => r.memory.id === 'oldLong')!;
      const short = recalled.find((r) => r.memory.id === 'oldShort')!;
      expect(long.score).toBeGreaterThan(short.score);
    });

    it('records access so consolidation can tell used memories from stored ones', async () => {
      (repo.findLive as jest.Mock).mockResolvedValue([makeMemory({ id: 'a' })]);
      await service.recall({ workerId: 'w1' });
      expect(repo.touchMany).toHaveBeenCalledWith(['a']);
    });

    it('honours the limit', async () => {
      (repo.findLive as jest.Mock).mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => makeMemory({ id: `m${i}` })),
      );
      const recalled = await service.recall({ workerId: 'w1', limit: 3 });
      expect(recalled).toHaveLength(3);
    });

    it('renders recalled memories as prompt context', async () => {
      (repo.findLive as jest.Mock).mockResolvedValue([
        makeMemory({ id: 'a', content: 'Acme raised prices' }),
      ]);
      const context = await service.recallAsContext({ workerId: 'w1' });
      expect(context).toContain('Acme raised prices');
      expect(context).toMatch(/\[recent, \d+m ago\]/);
    });

    it('returns empty context when there is nothing to recall', async () => {
      expect(await service.recallAsContext({ workerId: 'w1' })).toBe('');
    });
  });

  describe('consolidation', () => {
    it('promotes memories that are both important and repeatedly used', async () => {
      (repo.findLive as jest.Mock).mockResolvedValue([
        makeMemory({ id: 'promote', importance: 0.8, accessCount: 3 }),
        makeMemory({ id: 'importantButUnused', importance: 0.9, accessCount: 0 }),
        makeMemory({ id: 'usedButTrivial', importance: 0.2, accessCount: 9 }),
      ]);

      const result = await service.consolidate('w1');

      expect(result.promoted).toBe(1);
      expect((repo.update as jest.Mock).mock.calls[0][0]).toBe('promote');
      expect((repo.update as jest.Mock).mock.calls[0][1]).toMatchObject({
        type: MemoryType.LONG_TERM,
        expiresAt: null,
      });
    });

    it('prunes expired entries', async () => {
      (repo.pruneExpired as jest.Mock).mockResolvedValue(7);
      const result = await service.consolidate('w1');
      expect(result.pruned).toBe(7);
    });
  });
});
