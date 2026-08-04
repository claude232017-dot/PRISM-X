import { EventBusService, MAX_CASCADE_DEPTH } from './event-bus.service';
import { DomainEvent } from './domain-events';
import { EventRepository } from '../database/repositories/tenant.repositories';
import { RequestContextStore, RequestContext } from '../shared/context/request-context';

const ctx: RequestContext = {
  userId: 'user-1',
  organizationId: 'org-a',
  roleKey: 'OWNER',
  permissions: [],
  requestId: 'req-1',
};

describe('EventBusService', () => {
  let repo: { append: jest.Mock; pending: number };
  let bus: EventBusService;

  beforeEach(() => {
    // `append` rather than `create`: event rows are buffered and written in
    // batches, and every read of the table drains the buffer first.
    repo = { append: jest.fn().mockResolvedValue(undefined), pending: 0 };
    bus = new EventBusService(repo as unknown as EventRepository);
  });

  it('persists and dispatches to a named subscriber', async () => {
    const handler = jest.fn();
    bus.on(DomainEvent.WorkerCreated, handler);

    await RequestContextStore.run(ctx, () =>
      bus.publish(DomainEvent.WorkerCreated, { workerId: 'w1' }),
    );

    expect(repo.append).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'worker.created' }),
    );
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'worker.created',
        organizationId: 'org-a',
        actorId: 'user-1',
      }),
    );
  });

  it('delivers to wildcard subscribers too', async () => {
    const wildcard = jest.fn();
    bus.onAny(wildcard);

    await RequestContextStore.run(ctx, () => bus.publish(DomainEvent.MissionStarted));

    expect(wildcard).toHaveBeenCalledTimes(1);
  });

  it('does not deliver an event to unrelated subscribers', async () => {
    const other = jest.fn();
    bus.on(DomainEvent.MissionFailed, other);

    await RequestContextStore.run(ctx, () => bus.publish(DomainEvent.MissionCompleted));

    expect(other).not.toHaveBeenCalled();
  });

  it('a throwing subscriber does not break the publisher', async () => {
    const exploding = jest.fn().mockRejectedValue(new Error('subscriber is broken'));
    const healthy = jest.fn();
    bus.on(DomainEvent.KnowledgeStored, exploding);
    bus.on(DomainEvent.KnowledgeStored, healthy);

    await expect(
      RequestContextStore.run(ctx, () => bus.publish(DomainEvent.KnowledgeStored)),
    ).resolves.toBeDefined();

    // The healthy subscriber still received the event.
    expect(healthy).toHaveBeenCalled();
  });

  it('a failed persist does not break the publisher', async () => {
    repo.append.mockRejectedValue(new Error('database is down'));
    const handler = jest.fn();
    bus.on(DomainEvent.WorkerCreated, handler);

    await expect(
      RequestContextStore.run(ctx, () => bus.publish(DomainEvent.WorkerCreated)),
    ).resolves.toBeDefined();
    expect(handler).toHaveBeenCalled();
  });

  it('persists an event for an explicit org even with no ambient context', async () => {
    // This is the registration path: the organization exists but nobody is
    // authenticated into it yet.
    await bus.publish(
      DomainEvent.OrganizationCreated,
      { name: 'Prism Labs' },
      { organizationId: 'org-new', actorId: 'user-new' },
    );

    expect(repo.append).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'organization.created', actorId: 'user-new' }),
    );
  });

  it('refuses to publish with no organization anywhere', async () => {
    await expect(bus.publish(DomainEvent.WorkerCreated)).rejects.toThrow(
      /no organizationId/i,
    );
  });

  it('stops a cascade that would otherwise recurse forever', async () => {
    // A subscriber that republishes the event it listens for. Without a bound
    // this recurses until the stack gives out, inside one request.
    let published = 0;
    bus.on(DomainEvent.WorkerCreated, async () => {
      published += 1;
      await bus.publish(DomainEvent.WorkerCreated);
    });

    await RequestContextStore.run(ctx, () => bus.publish(DomainEvent.WorkerCreated));

    // The root publish plus one dispatch per level up to the ceiling.
    expect(published).toBe(MAX_CASCADE_DEPTH);
    expect(bus.refusedCascades()['worker.created']).toBe(1);
    // Every event in the chain was still persisted — that is what makes the
    // loop diagnosable after the fact.
    expect(repo.append).toHaveBeenCalledTimes(MAX_CASCADE_DEPTH + 1);
  });

  it('a legitimate chain shorter than the ceiling runs to completion', async () => {
    const seen: string[] = [];
    bus.on(DomainEvent.MissionStarted, async () => {
      seen.push('mission');
      await bus.publish(DomainEvent.TaskStarted);
    });
    bus.on(DomainEvent.TaskStarted, async () => {
      seen.push('task');
      await bus.publish(DomainEvent.WorkerFinished);
    });
    bus.on(DomainEvent.WorkerFinished, () => {
      seen.push('worker');
    });

    await RequestContextStore.run(ctx, () => bus.publish(DomainEvent.MissionStarted));

    expect(seen).toEqual(['mission', 'task', 'worker']);
    expect(bus.refusedCascades()).toEqual({});
  });

  it('unsubscribe stops delivery', async () => {
    const handler = jest.fn();
    const off = bus.on(DomainEvent.WorkerCreated, handler);
    off();

    await RequestContextStore.run(ctx, () => bus.publish(DomainEvent.WorkerCreated));
    expect(handler).not.toHaveBeenCalled();
  });
});
