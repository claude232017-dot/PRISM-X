import { EventBusService } from './event-bus.service';
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
  let repo: { create: jest.Mock };
  let bus: EventBusService;

  beforeEach(() => {
    repo = { create: jest.fn().mockResolvedValue({ id: 'e1' }) };
    bus = new EventBusService(repo as unknown as EventRepository);
  });

  it('persists and dispatches to a named subscriber', async () => {
    const handler = jest.fn();
    bus.on(DomainEvent.WorkerCreated, handler);

    await RequestContextStore.run(ctx, () =>
      bus.publish(DomainEvent.WorkerCreated, { workerId: 'w1' }),
    );

    expect(repo.create).toHaveBeenCalledWith(
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
    repo.create.mockRejectedValue(new Error('database is down'));
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

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'organization.created', actorId: 'user-new' }),
    );
  });

  it('refuses to publish with no organization anywhere', async () => {
    await expect(bus.publish(DomainEvent.WorkerCreated)).rejects.toThrow(
      /no organizationId/i,
    );
  });

  it('unsubscribe stops delivery', async () => {
    const handler = jest.fn();
    const off = bus.on(DomainEvent.WorkerCreated, handler);
    off();

    await RequestContextStore.run(ctx, () => bus.publish(DomainEvent.WorkerCreated));
    expect(handler).not.toHaveBeenCalled();
  });
});
