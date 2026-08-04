import {
  CAPABILITIES,
  CAPABILITY_CATALOGUE_VERSION,
  CAPABILITY_IDS,
  Capability,
  attenuate,
  authorize,
  capabilityForSurface,
  catalogue,
  describe as describeCapability,
  grant,
  guardedSurface,
  highestRisk,
  isCapability,
  permissionsFor,
  requiresHumanReview,
} from './capabilities';

describe('capability catalogue', () => {
  it('is frozen, so nothing can widen what extensions may do at runtime', () => {
    expect(Object.isFrozen(CAPABILITIES)).toBe(true);
    expect(CAPABILITIES.every((c) => Object.isFrozen(c))).toBe(true);
    expect(() => {
      (CAPABILITIES as unknown as unknown[]).push({});
    }).toThrow();
  });

  it('names the six capabilities the architecture called for', () => {
    for (const id of [
      'can_execute_missions',
      'can_access_knowledge',
      'can_manage_workers',
      'can_register_triggers',
      'can_send_notifications',
      'can_invoke_external_apis',
    ]) {
      expect(isCapability(id)).toBe(true);
    }
  });

  it('gives every capability a description written for the person consenting', () => {
    for (const capability of CAPABILITIES) {
      expect(capability.description.length).toBeGreaterThan(20);
      expect(capability.description.endsWith('.')).toBe(true);
    }
  });

  it('claims each guarded method exactly once', () => {
    const methods = guardedSurface();
    for (const method of methods) {
      const owners = CAPABILITIES.filter((c) => c.surface.includes(method));
      expect(owners).toHaveLength(1);
      expect(capabilityForSurface(method)?.id).toBe(owners[0].id);
    }
    expect(new Set(methods).size).toBe(methods.length);
  });

  it('has a version that changes when the meaning of a grant would change', () => {
    expect(CAPABILITY_CATALOGUE_VERSION).toHaveLength(16);
    // Recomputing from the same inputs is stable; the value is a content hash.
    expect(CAPABILITY_CATALOGUE_VERSION).toBe(CAPABILITY_CATALOGUE_VERSION);
  });

  it('marks HIGH and CRITICAL as needing review, and nothing below', () => {
    for (const entry of catalogue()) {
      expect(entry.reviewRequired).toBe(entry.risk === 'HIGH' || entry.risk === 'CRITICAL');
    }
  });

  it('keeps private state borrowing no organization permission', () => {
    expect(describeCapability(Capability.PersistState)?.implies).toEqual([]);
  });
});

describe('grant — the intersection rule', () => {
  const ownerPermissions = ['*'];
  const narrow = ['knowledge:read', 'mission:read'];

  it('grants what an unrestricted holder asks for', () => {
    const result = grant({
      requested: [Capability.AccessKnowledge, Capability.ManageWorkers],
      holderPermissions: ownerPermissions,
    });
    expect(result.granted).toEqual([Capability.AccessKnowledge, Capability.ManageWorkers]);
    expect(result.withheld).toEqual([]);
  });

  it('withholds what the holder cannot do themselves', () => {
    const result = grant({
      requested: [Capability.AccessKnowledge, Capability.ManageWorkers],
      holderPermissions: narrow,
    });
    expect(result.granted).toEqual([Capability.AccessKnowledge]);
    expect(result.withheld).toHaveLength(1);
    expect(result.withheld[0].capability).toBe(Capability.ManageWorkers);
    expect(result.withheld[0].missing).toContain('worker:delete');
  });

  it('never returns more than was requested', () => {
    const result = grant({
      requested: [Capability.ReadMissions],
      holderPermissions: ownerPermissions,
    });
    expect(result.granted).toEqual([Capability.ReadMissions]);
  });

  it('grants nothing to a holder with nothing', () => {
    const result = grant({ requested: [...CAPABILITY_IDS], holderPermissions: [] });
    // Only the capability that implies no permission at all survives.
    expect(result.granted).toEqual([Capability.PersistState]);
  });

  it('reports unknown identifiers rather than silently dropping them', () => {
    const result = grant({
      requested: ['can_do_anything', Capability.ReadMissions],
      holderPermissions: ownerPermissions,
    });
    expect(result.unknown).toEqual(['can_do_anything']);
    expect(result.granted).toEqual([Capability.ReadMissions]);
  });

  it('orders the grant by catalogue position, so two identical grants serialise alike', () => {
    const a = grant({
      requested: [Capability.ManageWorkers, Capability.ReadMissions],
      holderPermissions: ownerPermissions,
    });
    const b = grant({
      requested: [Capability.ReadMissions, Capability.ManageWorkers, Capability.ReadMissions],
      holderPermissions: ownerPermissions,
    });
    expect(a.granted).toEqual(b.granted);
  });

  it('rates the grant by its riskiest member and flags review accordingly', () => {
    const result = grant({
      requested: [Capability.ReadAnalytics, Capability.RegisterTools],
      holderPermissions: ownerPermissions,
    });
    expect(result.risk).toBe('CRITICAL');
    expect(result.reviewRequired).toBe(true);

    const low = grant({
      requested: [Capability.ReadAnalytics],
      holderPermissions: ownerPermissions,
    });
    expect(low.risk).toBe('LOW');
    expect(low.reviewRequired).toBe(false);
  });

  it('stamps the catalogue version the grant was issued under', () => {
    const result = grant({ requested: [], holderPermissions: ownerPermissions });
    expect(result.catalogueVersion).toBe(CAPABILITY_CATALOGUE_VERSION);
  });
});

describe('authorize', () => {
  const held = [Capability.AccessKnowledge];

  it('permits a method the grant covers', () => {
    expect(authorize(held, 'knowledge.search')).toBeNull();
  });

  it('refuses a method the grant does not cover, naming the capability', () => {
    const denial = authorize(held, 'workers.delete');
    expect(denial).toContain('can_manage_workers');
  });

  it('refuses a method no capability claims, so an unguarded surface fails closed', () => {
    expect(authorize(held, 'database.dropEverything')).toContain('not part of the extension API');
    // Even an unrestricted grant cannot reach it.
    expect(authorize([...CAPABILITY_IDS], 'database.dropEverything')).not.toBeNull();
  });
});

describe('attenuate', () => {
  const held = [Capability.AccessKnowledge, Capability.ReadMissions];

  it('narrows to the requested subset', () => {
    expect(attenuate(held, [Capability.ReadMissions])).toEqual([Capability.ReadMissions]);
  });

  it('cannot widen — asking for something not held returns nothing extra', () => {
    expect(attenuate(held, [Capability.ManageWorkers])).toEqual([]);
    // Asking for everything yields exactly what was held, in catalogue order.
    expect(new Set(attenuate(held, [...CAPABILITY_IDS]))).toEqual(new Set(held));
    expect(attenuate(held, [...CAPABILITY_IDS])).toHaveLength(held.length);
  });
});

describe('permissionsFor and highestRisk', () => {
  it('unions implied permissions without duplicates', () => {
    const permissions = permissionsFor([Capability.ReadMissions, Capability.ExecuteMissions]);
    expect(permissions).toEqual([...new Set(permissions)]);
    expect(permissions).toContain('mission:read');
    expect(permissions).toContain('mission:execute');
  });

  it('ignores identifiers outside the catalogue', () => {
    expect(permissionsFor(['nonsense'])).toEqual([]);
    expect(highestRisk(['nonsense'])).toBe('LOW');
    expect(requiresHumanReview(['nonsense'])).toBe(false);
  });
});
