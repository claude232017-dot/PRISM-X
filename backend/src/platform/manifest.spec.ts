import {
  DEFAULT_LIMITS,
  PLATFORM_API_VERSION,
  PLATFORM_LIMITS,
  analyseUpgrade,
  digestOf,
  resolveLimits,
  secretFields,
  validate,
  validateConfig,
} from './manifest';
import type { ExtensionManifest } from './manifest';
import * as semver from './semver';

const base = {
  slug: 'daily-digest',
  name: 'Daily Digest',
  version: '1.0.0',
  engine: '^1.0.0',
  capabilities: ['can_read_missions', 'can_persist_state'],
};

const valid = (overrides: Record<string, unknown> = {}) =>
  validate({ ...base, ...overrides });

describe('semver', () => {
  it('orders releases, with prereleases ranking below their release', () => {
    expect(semver.compare('1.0.0', '1.0.1')).toBe(-1);
    expect(semver.compare('1.10.0', '1.9.0')).toBe(1);
    expect(semver.compare('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(semver.compare('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    expect(semver.compare('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    // Numeric identifiers rank below alphanumeric ones.
    expect(semver.compare('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(semver.compare('1.0.0+build1', '1.0.0+build2')).toBe(0);
  });

  it('treats 0.x minor bumps as breaking, as the specification requires', () => {
    expect(semver.isBreakingUpgrade('1.0.0', '1.1.0')).toBe(false);
    expect(semver.isBreakingUpgrade('1.0.0', '2.0.0')).toBe(true);
    expect(semver.isBreakingUpgrade('0.1.0', '0.2.0')).toBe(true);
    expect(semver.isBreakingUpgrade('0.1.0', '0.1.1')).toBe(false);
  });

  it('expands caret and tilde ranges to the bounds they stand for', () => {
    expect(semver.satisfies('1.5.0', '^1.2.3')).toBe(true);
    expect(semver.satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(semver.satisfies('0.2.9', '^0.2.3')).toBe(true);
    expect(semver.satisfies('0.3.0', '^0.2.3')).toBe(false);
    expect(semver.satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(semver.satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(semver.satisfies('1.5.0', '>=1.2.0 <2.0.0')).toBe(true);
    expect(semver.satisfies('1.5.0', '^0.1.0 || ^1.0.0')).toBe(true);
    expect(semver.satisfies('1.5.0', '*')).toBe(true);
  });

  it('answers false for an unreadable range rather than throwing', () => {
    // A compatibility declaration nobody can read should block, not wave through.
    expect(semver.satisfies('1.0.0', 'not-a-range')).toBe(false);
    expect(semver.isValidRange('not-a-range')).toBe(false);
  });
});

describe('manifest validation', () => {
  it('accepts a well-formed manifest and returns a digest', () => {
    const result = valid();
    expect(result.ok).toBe(true);
    expect(result.digest).toHaveLength(64);
    expect(result.manifest?.slug).toBe('daily-digest');
  });

  it('reports every problem at once, by field', () => {
    const result = validate({ slug: 'Bad Slug', name: 'x', version: '1', capabilities: 'no' });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toEqual(
      expect.arrayContaining(['slug', 'name', 'version', 'capabilities']),
    );
  });

  it('refuses a capability outside the catalogue', () => {
    const result = valid({ capabilities: ['can_do_anything'] });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('can_do_anything');
  });

  it('refuses an engine range this platform cannot satisfy', () => {
    const result = valid({ engine: '^99.0.0' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'engine')).toBe(true);
    expect(valid({ engine: `^${PLATFORM_API_VERSION}` }).ok).toBe(true);
  });

  it('refuses a contribution asking for a capability the extension did not request', () => {
    const result = valid({
      capabilities: ['can_persist_state', 'can_register_workers'],
      contributes: { workers: [{ key: 'w', name: 'W', capabilities: ['can_manage_workers'] }] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('can_manage_workers');
  });

  it('refuses a secret config field carrying a default', () => {
    const result = valid({ config: { token: { type: 'secret', default: 'oops' } } });
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('config.token');
  });

  it('refuses a migration that targets a version ahead of the release', () => {
    const result = valid({ migrations: [{ to: '2.0.0', description: 'later' }] });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('ahead of this release');
  });

  it('warns rather than fails when a declaration is merely inconsistent', () => {
    const result = valid({ subscribes: ['mission.completed'] });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.field === 'subscribes')).toBe(true);
  });

  it('refuses an extension that depends on itself', () => {
    const result = valid({ dependencies: { 'daily-digest': '^1.0.0' } });
    expect(result.ok).toBe(false);
  });
});

describe('digest', () => {
  it('is stable across key reordering, which is what jsonb does to a manifest', () => {
    // Postgres jsonb stores a normalised form and hands back keys in its own
    // order, not the order they were written in. Reversing every object's keys
    // reproduces that without needing a database.
    const shuffle = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(shuffle);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([k, v]) => [k, shuffle(v)]),
        );
      }
      return value;
    };

    const a = valid({
      capabilities: ['can_read_missions', 'can_persist_state', 'can_register_tools'],
      contributes: { tools: [{ key: 't', name: 'T', description: 'Does a thing.' }] },
      limits: { callsPerMinute: 30, timeoutMs: 5000 },
      dependencies: { other: '^1.0.0' },
    }).manifest!;

    const reordered = shuffle(a) as ExtensionManifest;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(a));
    expect(digestOf(reordered)).toBe(digestOf(a));
  });

  it('changes when what the extension may do changes', () => {
    const a = valid().manifest!;
    const b = valid({ capabilities: ['can_read_missions'] }).manifest!;
    expect(digestOf(a)).not.toBe(digestOf(b));
  });

  it('ignores fields that do not affect authority', () => {
    const a = valid().manifest!;
    const b = valid({ description: 'A different description entirely.' }).manifest!;
    expect(digestOf(a)).toBe(digestOf(b));
  });
});

describe('limits', () => {
  it('clamps a greedy request to the platform ceiling rather than rejecting it', () => {
    const resolved = resolveLimits({ callsPerMinute: 10_000_000 });
    expect(resolved.callsPerMinute).toBe(PLATFORM_LIMITS.callsPerMinute);
  });

  it('honours a request below the default', () => {
    expect(resolveLimits({ callsPerMinute: 5 }).callsPerMinute).toBe(5);
  });

  it('falls back to the default for anything unstated or nonsensical', () => {
    const resolved = resolveLimits({ timeoutMs: Number.NaN });
    expect(resolved.timeoutMs).toBe(DEFAULT_LIMITS.timeoutMs);
    expect(resolveLimits().storageKeys).toBe(DEFAULT_LIMITS.storageKeys);
  });
});

describe('upgrade analysis', () => {
  const current = valid().manifest!;
  const candidate = (overrides: Record<string, unknown>) =>
    valid({ ...overrides }).manifest!;

  it('blocks a downgrade', () => {
    const result = analyseUpgrade(current, { ...current, version: '0.9.0' });
    expect(result.blocked).toBe(true);
    expect(result.changes.some((c) => c.code === 'downgrade')).toBe(true);
  });

  it('blocks reinstalling the same version', () => {
    const result = analyseUpgrade(current, current);
    expect(result.blocked).toBe(true);
    expect(result.changes.some((c) => c.code === 'same_version')).toBe(true);
  });

  it('blocks a candidate for a different extension', () => {
    const result = analyseUpgrade(current, { ...current, slug: 'other', version: '2.0.0' });
    expect(result.blocked).toBe(true);
  });

  it('treats a new capability as breaking, not merely notable', () => {
    const result = analyseUpgrade(
      current,
      candidate({ version: '1.1.0', capabilities: [...current.capabilities, 'can_invoke_external_apis'] }),
    );
    expect(result.breaking).toBe(true);
    expect(result.addedCapabilities).toEqual(['can_invoke_external_apis']);
  });

  it('calls out a capability grab hidden in a patch release', () => {
    const result = analyseUpgrade(
      current,
      candidate({ version: '1.0.1', capabilities: [...current.capabilities, 'can_manage_storage'] }),
    );
    expect(result.changes.some((c) => c.code === 'undeclared_capability_change')).toBe(true);
  });

  it('treats a removed contribution as breaking', () => {
    const withTool = candidate({
      capabilities: [...current.capabilities, 'can_register_tools'],
      contributes: { tools: [{ key: 't', name: 'T', description: 'Does a thing.' }] },
    });
    const without = candidate({
      version: '1.1.0',
      capabilities: [...current.capabilities, 'can_register_tools'],
    });
    const result = analyseUpgrade(withTool, without);
    expect(result.breaking).toBe(true);
    expect(result.changes.some((c) => c.code === 'contribution_removed')).toBe(true);
  });

  it('separates blocking from breaking, so an upgrade can still be consented to', () => {
    const result = analyseUpgrade(current, candidate({ version: '2.0.0' }));
    expect(result.blocked).toBe(false);
    expect(result.breaking).toBe(true);
    expect(result.release).toBe('MAJOR');
  });

  it('treats a new required setting with no default as breaking', () => {
    const result = analyseUpgrade(
      current,
      candidate({ version: '1.1.0', config: { channel: { type: 'string', required: true } } }),
    );
    expect(result.changes.some((c) => c.code === 'config_required_added')).toBe(true);
    expect(result.breaking).toBe(true);
  });

  it('selects only the migrations between the two versions, in order', () => {
    const from = { ...current, version: '1.0.0' };
    const to = candidate({
      version: '3.0.0',
      migrations: [
        { to: '3.0.0', description: 'third' },
        { to: '1.0.0', description: 'already applied' },
        { to: '2.0.0', description: 'second' },
      ],
    });
    const result = analyseUpgrade(from, to);
    expect(result.migrations.map((m) => m.to)).toEqual(['2.0.0', '3.0.0']);
  });
});

describe('config', () => {
  const manifest = valid({
    config: {
      channel: { type: 'string', required: true, default: '#ops' },
      retries: { type: 'number' },
      verbose: { type: 'boolean' },
      mode: { type: 'enum', options: ['fast', 'thorough'] },
      token: { type: 'secret', required: true },
    },
  }).manifest!;

  it('coerces values a form would submit as strings', () => {
    const result = validateConfig(manifest, {
      retries: '3',
      verbose: 'true',
      mode: 'fast',
      token: 'abc',
    });
    expect(result.ok).toBe(true);
    expect(result.values.retries).toBe(3);
    expect(result.values.verbose).toBe(true);
    expect(result.values.channel).toBe('#ops');
  });

  it('refuses a value outside an enum', () => {
    const result = validateConfig(manifest, { mode: 'sideways', token: 'abc' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('mode');
  });

  it('refuses a setting the manifest never declared', () => {
    const result = validateConfig(manifest, { token: 'abc', surprise: 1 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'surprise')).toBe(true);
  });

  it('requires what is marked required', () => {
    expect(validateConfig(manifest, {}).ok).toBe(false);
  });

  it('identifies which fields must be sealed', () => {
    expect(secretFields(manifest)).toEqual(['token']);
  });
});
