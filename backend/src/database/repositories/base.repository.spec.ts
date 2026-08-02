import { NotFoundException } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { PrismaService } from '../prisma.service';
import { RequestContextStore, RequestContext } from '../../shared/context/request-context';

interface Widget {
  id: string;
  organizationId: string;
}

class WidgetRepository extends BaseRepository<Widget> {
  protected readonly modelName = 'widget';
  constructor(prisma: PrismaService) {
    super(prisma);
  }
}

class EventLikeRepository extends BaseRepository<Widget> {
  protected readonly modelName = 'widget';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }
}

const ctx = (organizationId: string): RequestContext => ({
  userId: 'user-1',
  organizationId,
  roleKey: 'OWNER',
  permissions: [],
  requestId: 'req-1',
});

describe('BaseRepository', () => {
  let delegate: Record<string, jest.Mock>;
  let prisma: PrismaService;
  let repo: WidgetRepository;

  beforeEach(() => {
    delegate = {
      findFirst: jest.fn().mockResolvedValue({ id: 'w1', organizationId: 'org-a' }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    };
    prisma = { widget: delegate } as unknown as PrismaService;
    repo = new WidgetRepository(prisma);
  });

  describe('tenant scoping', () => {
    it('injects organizationId into every read', async () => {
      await RequestContextStore.run(ctx('org-a'), () => repo.findById('w1'));

      expect(delegate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'w1', organizationId: 'org-a' }),
        }),
      );
    });

    it('stamps organizationId on create, ignoring any supplied value', async () => {
      await RequestContextStore.run(ctx('org-a'), () =>
        repo.create({ name: 'x', organizationId: 'org-b' }),
      );

      expect(delegate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ organizationId: 'org-a' }),
      });
    });

    it('scopes updates through updateMany so the tenant predicate applies', async () => {
      await RequestContextStore.run(ctx('org-a'), () => repo.update('w1', { name: 'y' }));

      expect(delegate.update).not.toHaveBeenCalled();
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: 'w1', organizationId: 'org-a' }),
        data: { name: 'y' },
      });
    });

    it('throws rather than running an unscoped query with no context', async () => {
      await expect(repo.findById('w1')).rejects.toThrow(/No RequestContext/);
      expect(delegate.findFirst).not.toHaveBeenCalled();
    });

    it('treats an unauthenticated (empty-org) context as no context', async () => {
      const empty = { ...ctx(''), organizationId: '' };
      await expect(
        RequestContextStore.run(empty, () => repo.findById('w1')),
      ).rejects.toThrow(/No RequestContext/);
    });
  });

  describe('soft deletes', () => {
    it('excludes deleted rows by default', async () => {
      await RequestContextStore.run(ctx('org-a'), () => repo.findMany());
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
      );
    });

    it('includes them when explicitly asked', async () => {
      await RequestContextStore.run(ctx('org-a'), () =>
        repo.findMany({}, { withDeleted: true }),
      );
      const where = delegate.findMany.mock.calls[0][0].where;
      expect(where).not.toHaveProperty('deletedAt');
    });

    it('soft-deletes by stamping deletedAt', async () => {
      await RequestContextStore.run(ctx('org-a'), () => repo.remove('w1'));
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: 'w1', organizationId: 'org-a' }),
        data: { deletedAt: expect.any(Date) },
      });
      expect(delegate.deleteMany).not.toHaveBeenCalled();
    });

    it('hard-deletes for models that do not support soft deletion', async () => {
      const events = new EventLikeRepository(prisma);
      await RequestContextStore.run(ctx('org-a'), () => events.remove('w1'));
      expect(delegate.deleteMany).toHaveBeenCalled();
      expect(delegate.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('not-found handling', () => {
    it('raises 404 when a scoped update matches nothing', async () => {
      delegate.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        RequestContextStore.run(ctx('org-a'), () => repo.update('missing', {})),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('raises 404 when a scoped delete matches nothing', async () => {
      delegate.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        RequestContextStore.run(ctx('org-a'), () => repo.remove('missing')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('findByIdOrFail raises 404 on a miss', async () => {
      delegate.findFirst.mockResolvedValue(null);
      await expect(
        RequestContextStore.run(ctx('org-a'), () => repo.findByIdOrFail('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('isolates concurrent requests in separate contexts', async () => {
    await Promise.all([
      RequestContextStore.run(ctx('org-a'), async () => {
        await new Promise((r) => setTimeout(r, 10));
        return repo.findById('w1');
      }),
      RequestContextStore.run(ctx('org-b'), () => repo.findById('w2')),
    ]);

    const orgs = delegate.findFirst.mock.calls.map((c) => c[0].where.organizationId);
    expect(orgs.sort()).toEqual(['org-a', 'org-b']);
  });
});
