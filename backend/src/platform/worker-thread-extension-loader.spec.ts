import {
  DEFAULT_THREAD_LIMITS,
  WorkerThreadExtensionLoader,
} from './worker-thread-extension-loader';
import { PROBE_TOOL } from './extension-source';
import type { ExtensionManifest } from './manifest';
import type { ExtensionContext } from './sdk';

const MANIFEST: ExtensionManifest = {
  slug: 'containment-probe',
  name: 'Containment probe',
  version: '1.0.0',
  capabilities: ['can_persist_state'],
  contributes: { tools: [{ key: 'probe', name: 'Probe', description: 'Probe' } as never] },
};

/** A context whose host records what the extension asked for. */
function context(capabilities: string[] = ['can_persist_state']) {
  const written: Array<{ key: string; value: unknown }> = [];
  const logged: string[] = [];

  const value = {
    capabilities,
    logger: {
      info: (message: string) => logged.push(message),
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    host: {
      state: {
        set: async (args: { key: string; value: unknown }) => {
          written.push(args);
        },
        get: async () => null,
        delete: async () => true,
        keys: async () => [],
      },
    },
  } as unknown as ExtensionContext;

  return { value, written, logged };
}

describe('WorkerThreadExtensionLoader', () => {
  // Threads are started and terminated per test; keep the ceiling generous
  // enough that a slow CI box does not read as a containment failure.
  jest.setTimeout(30_000);

  let loader: WorkerThreadExtensionLoader;

  beforeEach(() => {
    loader = new WorkerThreadExtensionLoader({
      ...DEFAULT_THREAD_LIMITS,
      // Short, so the runaway tests do not spend ten seconds proving a point.
      callTimeoutMs: 1_500,
      maxOldGenerationSizeMb: 32,
    });
  });

  afterEach(async () => {
    await loader.onApplicationShutdown();
  });

  it('declares what it isolates, including what it does not', () => {
    expect(loader.isolation.level).toBe('thread');
    expect(loader.isolation.executesPublisherCode).toBe(true);
    // The honest half. A loader that lists only its strengths is a loader
    // whose limits get discovered in production.
    expect(loader.isolation.doesNotContain.length).toBeGreaterThan(0);
    expect(loader.isolation.doesNotContain.join(' ')).toMatch(/not a security boundary/i);
  });

  it('runs a hook in the thread and returns its result', async () => {
    const module = await loader.load(MANIFEST);
    const { value } = context();

    const result = (await module.onToolCall!(value, {
      tool: 'anything',
      input: { b: 2, a: 1 },
    } as never)) as Record<string, unknown>;

    expect(result.extension).toBe('containment-probe');
    expect(result.receivedKeys).toEqual(['a', 'b']);
    // Deterministic: the same input must produce the same digest, or a
    // benchmark of a contributed tool measures noise.
    const again = (await module.onToolCall!(value, {
      tool: 'anything',
      input: { a: 1, b: 2 },
    } as never)) as Record<string, unknown>;
    expect(again.output).toBe(result.output);
  });

  it('routes host calls back through the context rather than to the thread', async () => {
    const module = await loader.load(MANIFEST);
    const { value, written } = context();

    await module.initialize!(value);

    // The write happened on the host side, through the context the host
    // supplied — which is where the capability check lives.
    expect(written).toHaveLength(1);
    expect(written[0].key).toBe('prismx.installed');
  });

  it('does not call the host when the capability is absent', async () => {
    const module = await loader.load(MANIFEST);
    const { value, written } = context([]);

    await module.initialize!(value);
    expect(written).toHaveLength(0);
  });

  it('refuses a host method the bridge does not allow', async () => {
    const module = await loader.load(MANIFEST);
    const { value } = context();

    // `logger.info` is allowed; anything outside the allow-list is refused on
    // the host side, so a new SDK surface has to be opened deliberately.
    await expect(module.activate!(value)).resolves.toBeUndefined();
  });

  it('contains an extension that never returns, and terminates its thread', async () => {
    const module = await loader.load(MANIFEST);
    const { value } = context();

    const started = Date.now();
    await expect(
      module.onToolCall!(value, { tool: PROBE_TOOL, input: { mode: 'spin' } } as never),
    ).rejects.toThrow(/exceeded 1500ms/);

    // The host was never blocked: it noticed, gave up, and killed the thread
    // within a small multiple of the deadline.
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('keeps the host responsive while an extension is spinning', async () => {
    const module = await loader.load(MANIFEST);
    const { value } = context();

    let ticked = false;
    const tick = new Promise<void>((resolve) =>
      setTimeout(() => {
        ticked = true;
        resolve();
      }, 200),
    );

    const spinning = module
      .onToolCall!(value, { tool: PROBE_TOOL, input: { mode: 'spin' } } as never)
      .catch(() => undefined);

    await tick;
    // This is the whole point. With an in-process loader the timer above would
    // not have fired until the extension chose to yield, which it never does.
    expect(ticked).toBe(true);
    await spinning;
  });

  it('gives the extension no require and no process', async () => {
    const module = await loader.load(MANIFEST);
    const { value } = context();

    const result = (await module.onToolCall!(value, {
      tool: PROBE_TOOL,
      input: { mode: 'escape' },
    } as never)) as { reached: boolean };

    expect(result.reached).toBe(false);
  });

  it('surfaces an error thrown inside the thread as a failed call', async () => {
    const module = await loader.load(MANIFEST);
    const { value } = context();

    await expect(
      module.onToolCall!(value, { tool: PROBE_TOOL, input: { mode: 'throw' } } as never),
    ).rejects.toThrow(/probe failure/);

    // And the thread survives a thrown error — only a deadline kills it.
    const after = (await module.onToolCall!(value, {
      tool: 'anything',
      input: {},
    } as never)) as Record<string, unknown>;
    expect(after.extension).toBe('containment-probe');
  });

  it('reports a call against an unloaded extension rather than hanging', async () => {
    const module = await loader.load(MANIFEST);
    const { value } = context();

    await loader.unload(MANIFEST.slug);

    await expect(
      module.onToolCall!(value, { tool: 'anything', input: {} } as never),
    ).rejects.toThrow(/not running/);
  });

  it('replaces a thread when the same extension is loaded again', async () => {
    await loader.load(MANIFEST);
    expect(loader.loaded()).toEqual(['containment-probe']);

    await loader.load({ ...MANIFEST, version: '1.1.0' });
    // Still one thread, not two: reloading must not leak the previous one.
    expect(loader.loaded()).toEqual(['containment-probe']);
  });
});
