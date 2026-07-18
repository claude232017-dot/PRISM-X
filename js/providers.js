/* PRISM-X — providers.js
 * PHASE H0 — Intelligence Provider Layer.
 *
 * The Provider Manager is the single funnel for every intelligence request:
 *
 *   Worker → Bridge → Provider Manager → Selected Provider → response → Worker
 *
 * Workers never know which provider answered. Claude (Neural Link) and the
 * Local Cortex are live today; every other provider is a registered
 * placeholder that fails over to the Local Cortex until its API connects.
 * No real third-party APIs are called in Phase H0 — by design.
 */
window.PRISM = window.PRISM || {};

PRISM.providers = (function () {
  "use strict";
  const S = () => PRISM.store;
  const E = () => PRISM.engine;

  /* ================================================================== *
   * MODULE 9 — Provider Registry (static defs; custom ones persist in
   * state.customProviders and only require registration to appear)
   * ================================================================== */
  const CAPS = ["Reasoning", "Writing", "Coding", "Analysis", "Browser", "Terminal", "Tool Use", "MCP", "Filesystem"];

  const REGISTRY = [
    {
      id: "claude", name: "Claude", live: true, priority: 1, version: "API 2023-06-01",
      description: "Anthropic Claude family — powers the Neural Link today (Opus / Sonnet / Haiku via the AI Router).",
      capabilities: { Reasoning: 1, Writing: 1, Coding: 1, Analysis: 1, Browser: 0, Terminal: 0, "Tool Use": 0, MCP: 0, Filesystem: 0 },
      requiredCredentials: ["API Key"],
      configSchema: [{ key: "apiKey", label: "API Key", type: "password" }, { key: "model", label: "Default model", type: "text" }]
    },
    {
      id: "openai", name: "OpenAI", live: false, priority: 3, version: "placeholder",
      description: "GPT model family. Placeholder — connects in a future phase.",
      capabilities: { Reasoning: 1, Writing: 1, Coding: 1, Analysis: 1, Browser: 0, Terminal: 0, "Tool Use": 1, MCP: 0, Filesystem: 0 },
      requiredCredentials: ["API Key", "Organization ID"],
      configSchema: [{ key: "apiKey", label: "API Key", type: "password" }, { key: "org", label: "Organization ID", type: "text" }]
    },
    {
      id: "gemini", name: "Gemini", live: false, priority: 4, version: "placeholder",
      description: "Google Gemini family. Placeholder — connects in a future phase.",
      capabilities: { Reasoning: 1, Writing: 1, Coding: 1, Analysis: 1, Browser: 0, Terminal: 0, "Tool Use": 1, MCP: 0, Filesystem: 0 },
      requiredCredentials: ["API Key"],
      configSchema: [{ key: "apiKey", label: "API Key", type: "password" }]
    },
    {
      id: "hermes", name: "Hermes Agent", live: false, priority: 5, version: "placeholder",
      description: "Autonomous agent framework with tool access. Placeholder — connects in a future phase.",
      capabilities: { Reasoning: 1, Writing: 0, Coding: 1, Analysis: 1, Browser: 1, Terminal: 1, "Tool Use": 1, MCP: 1, Filesystem: 1 },
      requiredCredentials: ["Endpoint URL", "Auth Token"],
      configSchema: [{ key: "endpoint", label: "Endpoint URL", type: "text" }, { key: "token", label: "Auth Token", type: "password" }, { key: "webhook", label: "Webhook URL", type: "text" }]
    },
    {
      id: "ollama", name: "Ollama", live: false, priority: 6, version: "placeholder",
      description: "Self-hosted open models over a local server. Placeholder — connects in a future phase.",
      capabilities: { Reasoning: 1, Writing: 1, Coding: 1, Analysis: 0, Browser: 0, Terminal: 0, "Tool Use": 0, MCP: 0, Filesystem: 0 },
      requiredCredentials: ["Host URL"],
      configSchema: [{ key: "host", label: "Host URL", type: "text" }, { key: "model", label: "Model tag", type: "text" }]
    },
    {
      id: "local", name: "Local Models", live: true, priority: 2, version: "cortex v1",
      description: "The Local Cortex — offline combinatorial generation. Always available, zero cost, fully private.",
      capabilities: { Reasoning: 0, Writing: 1, Coding: 0, Analysis: 0, Browser: 0, Terminal: 0, "Tool Use": 0, MCP: 0, Filesystem: 0 },
      requiredCredentials: [],
      configSchema: []
    },
    {
      id: "future", name: "Future Providers", live: false, priority: 9, version: "—",
      description: "Open slot — any provider implementing the Universal Provider Interface plugs in via registerProvider() with no Worker changes.",
      capabilities: {},
      requiredCredentials: ["varies"],
      configSchema: [{ key: "apiKey", label: "API Key", type: "password" }, { key: "oauth", label: "OAuth client", type: "text" }, { key: "webhook", label: "Webhook URL", type: "text" }]
    }
  ];

  /* MODULE 3 — the Universal Provider Interface every adapter must expose */
  const INTERFACE = ["generateText", "chat", "analyze", "reason", "summarize", "executeTask", "capabilities", "healthCheck"];

  /* MODULE 4 — the per-Worker "Intelligence Provider" field options */
  const PROVIDER_OPTIONS = [
    ["auto", "Auto"], ["claude", "Claude"], ["openai", "OpenAI"], ["gemini", "Gemini"],
    ["hermes", "Hermes Agent"], ["ollama", "Ollama"], ["local", "Local Model"]
  ];
  const FIELD_DESC = "Determines which intelligence provider this Worker should use when executing tasks.";

  function defs() { return REGISTRY.concat(S().state.customProviders || []); }
  function def(id) { return defs().find(d => d.id === id) || null; }
  function name(id) { const d = def(id); return d ? d.name : id; }

  /* runtime records (enabled / config / analytics) persist in state.providers */
  function ensure() {
    const st = S().state;
    st.providers = st.providers || [];
    st.customProviders = st.customProviders || [];
    defs().forEach(d => {
      if (!st.providers.find(p => p.id === d.id)) {
        st.providers.push({
          id: d.id,
          enabled: !!d.live,
          config: {},
          lastActivity: null,
          health: null,
          analytics: { requests: 0, successes: 0, failures: 0, totalMs: 0, tokensEst: 0, costEst: 0, lastError: null, lastErrorAt: null }
        });
      }
    });
    /* every AI Worker inherits the Intelligence Provider field (default Auto);
       human executors are flagged so no AI provider is ever resolved for them */
    ["clones", "ghosts", "shells"].forEach(k => (st[k] || []).forEach(w => { if (!w.provider) w.provider = "auto"; }));
    (st.executors || []).forEach(x => { if (!x.provider) x.provider = "human"; });
  }

  function rec(id) { ensure(); return S().state.providers.find(p => p.id === id) || null; }
  /* merged def + runtime view, sorted by priority */
  function list() {
    ensure();
    return defs()
      .map(d => Object.assign({}, d, rec(d.id)))
      .sort((a, b) => (a.priority || 9) - (b.priority || 9));
  }

  /* ================================================================== *
   * MODULE 8 — every provider interaction becomes a Bridge event
   * ================================================================== */
  function emitEv(text, meta) {
    if (window.PRISM && PRISM.bridge) PRISM.bridge.emit("provider", "🧠 " + text, meta || {});
  }

  /* ================================================================== *
   * MODULE 7 — health (placeholder statuses; live APIs will update these)
   * ================================================================== */
  const HEALTH_LABEL = {
    online: "Online", healthy: "Healthy", auth_required: "Authentication Required",
    offline: "Offline", maintenance: "Maintenance", rate_limited: "Rate Limited"
  };
  function healthOf(id) {
    const st = S().state;
    const p = rec(id);
    if (!p || !p.enabled) return "offline";
    if (id === "local") return "online";
    if (id === "claude") return st.settings.apiKey ? "healthy" : "auth_required";
    /* placeholders: credentials stored → parked in maintenance until live; none → auth required */
    const hasCfg = p.config && Object.keys(p.config).some(k => p.config[k]);
    return hasCfg ? "maintenance" : "auth_required";
  }
  function testConnection(id) {
    const p = rec(id);
    if (!p) return "offline";
    const h = healthOf(id);
    if (p.health && p.health !== h) emitEv(`Provider health changed — ${name(id)}: ${HEALTH_LABEL[p.health]} → ${HEALTH_LABEL[h]}.`, { priority: "medium" });
    p.health = h;
    p.lastActivity = Date.now();
    emitEv(`Test connection — ${name(id)} → ${HEALTH_LABEL[h]} (placeholder check, no live API validated).`);
    S().save();
    return h;
  }

  function toggle(id) {
    const p = rec(id);
    if (!p) return;
    p.enabled = !p.enabled;
    emitEv(`Provider ${p.enabled ? "enabled" : "disabled"} — ${name(id)}.`, { priority: "medium" });
    S().save();
  }

  /* MODULE 10 — future credentials stored locally, unused until APIs connect */
  function configure(id, config) {
    const p = rec(id);
    if (!p) return;
    p.config = config || {};
    emitEv(`Provider configured — ${name(id)} credentials stored (future integration, unused in Phase H0).`);
    S().save();
  }

  /* ================================================================== *
   * MODULE 6 — analytics (live counters for Claude / Local Cortex;
   * unconnected providers stay at their placeholder zeros)
   * ================================================================== */
  const COST_PER_1K = { claude: 0.012, openai: 0.010, gemini: 0.008, hermes: 0.005, ollama: 0, local: 0 };
  function track(id, ok, ms, chars, errMsg) {
    const p = rec(id);
    if (!p) return;
    const a = p.analytics;
    a.requests += 1;
    if (ok) a.successes += 1;
    else { a.failures += 1; a.lastError = (errMsg || "unknown error").slice(0, 200); a.lastErrorAt = Date.now(); }
    a.totalMs += ms || 0;
    const tok = Math.round((chars || 0) / 4);
    a.tokensEst += tok;
    a.costEst += (tok / 1000) * (COST_PER_1K[id] || 0);
    p.lastActivity = Date.now();
  }
  function analyticsOf(id) {
    const p = rec(id);
    if (!p) return null;
    const a = p.analytics, n = a.requests;
    const avg = n ? Math.round(a.totalMs / n) : 0;
    return {
      id, name: name(id), requests: n,
      successRate: n ? Math.round((a.successes / n) * 100) : null,
      failureRate: n ? Math.round((a.failures / n) * 100) : null,
      avgMs: avg, avgTaskMs: avg,
      tokensEst: a.tokensEst, costEst: +a.costEst.toFixed(4),
      lastError: a.lastError, lastErrorAt: a.lastErrorAt
    };
  }

  /* ================================================================== *
   * MODULES 2 + 4 — Provider Manager: selection + the single funnel
   * ================================================================== */
  const ROUTER_TO_ID = { "Claude": "claude", "GPT": "openai", "OpenAI": "openai", "Gemini": "gemini", "Multi-model": "claude" };

  /* Resolve which provider executes for a worker. Auto = the AI Router's
     category route, gated by the Neural Link toggle. Unavailable choices
     fail over to the Local Cortex (with the reason recorded). */
  function resolve(workerProvider, category) {
    ensure();
    const st = S().state;
    let chosen = workerProvider && workerProvider !== "auto" ? workerProvider : null;
    if (!chosen) {
      if (st.settings.engine === "neural" && st.settings.apiKey) {
        const route = (window.PRISM && PRISM.bridge) ? PRISM.bridge.routeFor(category || "Copywriting / content") : null;
        chosen = (route && ROUTER_TO_ID[route.provider]) || "claude";
      } else chosen = "local";
    }
    const p = rec(chosen);
    const reason =
      !def(chosen) ? "unknown provider" :
      !p || !p.enabled ? "disabled in the Intelligence Center" :
      chosen === "claude" && !st.settings.apiKey ? "authentication required (no API key)" :
      chosen !== "claude" && chosen !== "local" ? "placeholder — no live API in Phase H0" : null;
    if (chosen !== "local" && reason) return { id: "local", requested: chosen, switched: true, reason };
    return { id: chosen, requested: chosen, switched: false, reason: null };
  }

  function withTimeout(promise, ms) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout after ${Math.round(ms / 1000)}s`)), ms);
      promise.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
    });
  }

  /* Neural completions. engine.complete() delegates here, so every module's
     API call — clones, ghosts, shells — flows through the Provider Manager. */
  async function complete(system, prompt, settings, meta) {
    ensure();
    meta = meta || {};
    const sel = resolve(meta.provider || "auto", meta.category);
    const who = meta.workerName ? ` for ${meta.workerName}` : "";
    const evMeta = { workerId: meta.workerId || null, workerName: meta.workerName || null };

    if (sel.id !== "claude") {
      /* the requested provider can't run a neural completion — report and
         fail over; callers keep their Local Cortex fallback paths */
      if (sel.requested !== "local") {
        track(sel.requested, false, 0, 0, sel.reason || "not executable");
        emitEv(`Provider failed — ${name(sel.requested)}: ${sel.reason}.`, Object.assign({ priority: "medium" }, evMeta));
        emitEv(`Provider switched — ${name(sel.requested)} → Local Cortex${who}.`, evMeta);
      }
      throw new Error(`Provider "${name(sel.requested)}" unavailable (${sel.reason || "local-only"})`);
    }

    emitEv(`Execution started — provider "Claude" selected${who}.`, evMeta);
    const t0 = Date.now();
    try {
      const text = await withTimeout(E().complete(system, prompt, Object.assign({ __direct: true }, settings)), 90000);
      const ms = Date.now() - t0;
      track("claude", true, ms, (system + prompt + text).length);
      emitEv(`Execution completed — Claude answered in ${(ms / 1000).toFixed(1)}s${who}.`, evMeta);
      S().save();
      return text;
    } catch (err) {
      track("claude", false, Date.now() - t0, 0, err.message);
      const kind = /timeout/i.test(err.message) ? "Provider timeout" : "Provider failed";
      emitEv(`${kind} — Claude: ${err.message}.`, Object.assign({ priority: "medium" }, evMeta));
      S().save();
      throw err;
    }
  }

  /* Local Cortex executions report through the Manager too, so the funnel
     sees every intelligence request — including the free offline ones. */
  function recordLocal(info) {
    ensure();
    info = info || {};
    const who = info.workerName ? ` for ${info.workerName}` : "";
    const evMeta = { workerId: info.workerId || null, workerName: info.workerName || null };
    if (info.switched && info.requested && info.requested !== "local") {
      track(info.requested, false, 0, 0, info.reason);
      emitEv(`Provider failed — ${name(info.requested)}: ${info.reason}.`, Object.assign({ priority: "medium" }, evMeta));
      emitEv(`Provider switched — ${name(info.requested)} → Local Cortex${who}.`, evMeta);
    }
    emitEv(`Execution started — provider "Local Cortex" selected${who}.`, evMeta);
    track("local", true, 2, info.chars || 0);
    emitEv(`Execution completed — Local Cortex answered instantly${who}.`, evMeta);
    S().save();
  }

  /* ================================================================== *
   * MODULE 3 — adapters: one standardized interface per provider
   * ================================================================== */
  const adapters = {};
  function makeAdapter(id) {
    const exec = (fn) => async (req) => {
      req = req || {};
      if (id === "claude") {
        return complete(req.system || `Universal Provider Interface call: ${fn}.`, req.prompt || "", S().state.settings, Object.assign({ provider: "claude" }, req.meta || {}));
      }
      if (id === "local") {
        const text = req.localFn ? req.localFn() : `[Local Cortex · ${fn}] ${String(req.prompt || "").slice(0, 200)}`;
        recordLocal(Object.assign({ chars: String(text).length }, req.meta || {}));
        return text;
      }
      const err = new Error(`${name(id)} is a placeholder in Phase H0 — no live API. The interface is standardized; only credentials + a live transport are missing.`);
      track(id, false, 0, 0, err.message);
      throw err;
    };
    const a = {};
    ["generateText", "chat", "analyze", "reason", "summarize", "executeTask"].forEach(fn => { a[fn] = exec(fn); });
    a.capabilities = () => (def(id) || {}).capabilities || {};
    a.healthCheck = () => healthOf(id);
    return a;
  }
  function adapter(id) { return adapters[id] = adapters[id] || makeAdapter(id); }
  function interfaceComplete(id) { return INTERFACE.every(fn => typeof adapter(id)[fn] === "function"); }

  /* ================================================================== *
   * MODULE 9 — registration: future providers plug in with no Worker
   * changes. Registration alone makes them selectable everywhere.
   * ================================================================== */
  function registerProvider(input) {
    ensure();
    const st = S().state;
    if (!input || !input.id || !/^[a-z0-9_-]+$/.test(input.id)) return { ok: false, reason: "id required (lowercase letters / digits / dashes)" };
    if (def(input.id)) return { ok: false, reason: `"${input.id}" is already registered` };
    const d = {
      id: input.id,
      name: input.name || input.id,
      description: input.description || "Custom provider registered via the Provider Registry.",
      version: input.version || "0.1",
      priority: input.priority || 7,
      live: false,
      capabilities: input.capabilities || {},
      requiredCredentials: input.requiredCredentials || ["API Key"],
      configSchema: input.configSchema || [{ key: "apiKey", label: "API Key", type: "password" }]
    };
    st.customProviders.push(d);
    ensure(); /* provisions its runtime record */
    emitEv(`Provider registered — ${d.name} joined the registry (Universal Provider Interface: ${INTERFACE.length}/8 functions standardized).`, { priority: "medium" });
    S().save();
    return { ok: true, provider: d };
  }

  /* ================================================================== *
   * boot
   * ================================================================== */
  function boot() {
    ensure();
    const st = S().state;
    if (!st.providerLayerReady) {
      st.providerLayerReady = true;
      emitEv(`Intelligence Provider Layer online — ${defs().length} providers registered; the Provider Manager now routes every intelligence request.`, { priority: "medium" });
    }
    S().save();
  }

  return {
    CAPS, INTERFACE, PROVIDER_OPTIONS, FIELD_DESC, HEALTH_LABEL,
    defs, def, name, list, rec, ensure,
    resolve, complete, recordLocal,
    adapter, interfaceComplete,
    toggle, configure, testConnection, healthOf,
    track, analyticsOf, registerProvider, boot
  };
})();
