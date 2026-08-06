import type { ExtensionManifest } from './manifest';

/**
 * The source an extension runs.
 *
 * PRISM-X has no package format yet, so there is no publisher-supplied bundle
 * to execute. What there *is* — and what matters for containment — is a real
 * body of JavaScript, generated from the manifest, that the isolating loader
 * evaluates the same way it would evaluate somebody else's code: through the
 * same RPC bridge, under the same resource limits, killable mid-call.
 *
 * That distinction is the point of this file. Generating the source rather than
 * synthesising an object means the isolation boundary is exercised for real
 * — a runaway loop in here really does have to be terminated by the host, and
 * a host call really does have to cross a thread boundary. When a package
 * format arrives, only this function is replaced; nothing about the containment
 * changes, because the containment was never relying on the code being ours.
 *
 * The generated behaviour is deterministic: the same manifest and the same
 * input always produce the same output, so a test that passes once passes
 * again and a benchmark measures the platform rather than a random number.
 *
 * `probe` exists so the isolation itself can be tested. It is reachable only
 * through a tool call whose name the platform reserves, and it is how the
 * validation suite asks an extension to spin forever, allocate without bound,
 * or reach for the filesystem — questions you cannot answer about a sandbox
 * without something inside it willing to misbehave.
 */
export function synthesiseSource(manifest: ExtensionManifest): string {
  const meta = JSON.stringify({
    slug: manifest.slug,
    version: manifest.version,
    tools: (manifest.contributes?.tools ?? []).map((tool) => tool.key),
    workers: (manifest.contributes?.workers ?? []).map((worker) => worker.key),
  });

  return `
'use strict';
const MANIFEST = ${meta};

/**
 * Canonical serialisation: object keys sorted, recursively.
 *
 * \`JSON.stringify\` preserves insertion order, so { b, a } and { a, b } — the
 * same input by any sensible definition — would hash differently. Anything
 * built on that digest, a cache key or a benchmark, would then be
 * non-deterministic in a way that only shows up occasionally.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

/** Stable pseudo-value derived from its inputs — never Math.random. */
function digest(...parts) {
  return __host.digest(parts.map(canonical).join('|'));
}

async function initialize(context) {
  if (!context.capabilities.includes('can_persist_state')) return;
  await __host.call('state.set', {
    key: 'prismx.installed',
    value: { version: MANIFEST.version, capabilities: context.capabilities.slice() },
  });
}

async function activate(context) {
  await __host.call('logger.info', {
    message: MANIFEST.slug + ' activated',
    data: { capabilities: context.capabilities.length },
  });
}

async function deactivate() {
  await __host.call('logger.info', { message: MANIFEST.slug + ' deactivated' });
}

async function migrate(context, step) {
  if (!context.capabilities.includes('can_persist_state')) return;
  await __host.call('state.set', {
    key: 'prismx.migrations',
    value: { lastApplied: step.to, from: context.fromVersion, to: context.toVersion },
  });
}

async function onEvent(context, event) {
  if (!context.capabilities.includes('can_persist_state')) return;
  await __host.call('state.set', {
    key: 'prismx.lastEvent',
    value: { name: event.name, at: event.occurredAt, digest: digest(event.name, event.payload) },
  });
}

async function onToolCall(context, invocation) {
  // The probe surface. Deliberately reachable, deliberately obvious, and the
  // only way to prove the sandbox contains anything.
  if (invocation.tool === '__prismx_probe') {
    const mode = (invocation.input || {}).mode;
    if (mode === 'spin') {
      // Never yields. The host must terminate this thread.
      for (;;) {}
    }
    if (mode === 'allocate') {
      const held = [];
      for (;;) held.push(new Array(1024 * 1024).fill(7));
    }
    if (mode === 'escape') {
      // Reaching for anything outside the provided context must throw rather
      // than resolve, or the isolation is decorative.
      return { reached: typeof require === 'function' || typeof process !== 'undefined' };
    }
    if (mode === 'throw') throw new Error('probe failure');
    return { ok: true, isolated: true };
  }

  return {
    tool: invocation.tool,
    extension: MANIFEST.slug,
    output: digest(MANIFEST.slug, invocation.tool, invocation.input),
    receivedKeys: Object.keys(invocation.input || {}).sort(),
  };
}

async function onWorkerRun(context, invocation) {
  return {
    worker: invocation.worker,
    extension: MANIFEST.slug,
    summary: 'Handled by ' + MANIFEST.slug + '@' + MANIFEST.version,
    output: digest(MANIFEST.slug, invocation.worker, invocation.input),
  };
}

__exports.initialize = initialize;
__exports.activate = activate;
__exports.deactivate = deactivate;
__exports.migrate = migrate;
__exports.onEvent = onEvent;
__exports.onToolCall = onToolCall;
__exports.onWorkerRun = onWorkerRun;
`;
}

/** The tool name reserved for exercising the sandbox. Never contributable. */
export const PROBE_TOOL = '__prismx_probe';
