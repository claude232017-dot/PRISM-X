/* PRISM-X — bridge.js · PHASE ALPHA: FOUNDATION PROTOCOL
 * The PRISM-X Bridge — the nervous system that turns four phases of modules
 * into one operating system. Everything here is REAL infrastructure over the
 * existing state, with two placeholders the spec explicitly mandates:
 * Integration connections (mock) and Workflow execution (simulated).
 *
 * Contents:
 *   • Universal Worker System  — normalizing adapter over clones/ghosts/shells/executors
 *   • Event Bus                — every meaningful action, timestamped + categorized
 *   • Shared Memory Engine     — private / shared / global tiers, searchable
 *   • Integration Manager      — placeholder cards (no real APIs, per spec)
 *   • Workflow Registry        — simulated execution
 *   • AI Router                — task-category → provider/model routing (real for Claude)
 *   • Permission Engine        — role × resource access matrix
 *   • Internal API Layer       — standardized internal endpoints
 *   • System Health            — live metrics
 *   • Bridge dispatch + log    — the single routing choke point
 */
window.PRISM = window.PRISM || {};

PRISM.bridge = (function () {
  "use strict";
  const S = () => PRISM.store, E = () => PRISM.engine;
  const uid = p => S().uid(p);

  /* ================================================================== *
   * WORKER TYPES
   * ================================================================== */
  const WORKER_TYPES = {
    clone:    { label: "Clone",          icon: "◈", color: "#f5c542" },
    ghost:    { label: "Product Ghost",  icon: "👻", color: "#9085e9" },
    shell:    { label: "Outer Shell",    icon: "🎭", color: "#3fc2e0" },
    executor: { label: "Human Executor", icon: "👤", color: "#6ea8ef" }
  };

  /* ------------------------------------------------------------------ *
   * MODULE 1 — Universal Worker System (adapter, not a rewrite)
   * Every entity is projected through one shared Worker schema.
   * ------------------------------------------------------------------ */
  function normClone(c) {
    return {
      id: c.id, type: "clone", name: c.name,
      provider: c.provider || "auto",
      mission: c.target || c.role,
      knowledge: c.skills || "",
      memory: c.memory || [],
      tools: (c.skills ? c.skills.split(/,\s*/) : []),
      workflows: workflowsFor(c.id),
      metrics: { tasks: c.stats.tasks, leads: c.stats.leads, score: c.stats.ratingCount ? +(c.stats.ratingSum / c.stats.ratingCount).toFixed(1) : 0 },
      revenue: c.stats.earnings,
      status: E().effectiveStatus(c),
      evolution: (c.memory || []).slice(-3),
      raw: c
    };
  }
  function normGhost(g) {
    const G = PRISM.ghosts;
    return {
      id: g.id, type: "ghost", name: g.name,
      provider: g.provider || "auto",
      mission: `${g.focus} · ${g.niche} · ${G.money(g.targetIncome)}/day`,
      knowledge: (g.skills || []).join(", "),
      memory: g.memory || [],
      tools: g.skills || [],
      workflows: workflowsFor(g.id),
      metrics: { products: G.ghostProducts(g).length, hits: G.ghostProducts(g).filter(p => p.status === "hit").length },
      revenue: G.ghostRevenue(g),
      status: G.ghostStatus(g).label.toLowerCase(),
      evolution: (g.memory || []).slice(-3),
      raw: g
    };
  }
  function normShell(s) {
    const SH = PRISM.shells;
    return {
      id: s.id, type: "shell", name: s.name,
      provider: s.provider || "auto",
      mission: `${s.niche} · ${s.persona} · ${s.offerSource}`,
      knowledge: s.platforms.join(", "),
      memory: s.memory || [],
      tools: s.platforms || [],
      workflows: workflowsFor(s.id),
      metrics: { followers: s.followers, posts: s.posts.length, power: SH.powerMeter(s) },
      revenue: (s.daily || []).reduce((a, d) => a + d.income, 0),
      status: s.personaTest ? "persona-test" : "broadcasting",
      evolution: (s.memory || []).slice(-3),
      raw: s
    };
  }
  function normExecutor(x) {
    return {
      id: x.id, type: "executor", name: x.name,
      provider: "human",
      mission: `${x.role} · ${x.permission}`,
      knowledge: x.role,
      memory: x.memory || [],
      tools: [x.role],
      workflows: workflowsFor(x.id),
      metrics: { tasksDone: x.tasksDone, score: x.score, streak: x.streak },
      revenue: x.earnings,
      status: x.active ? "active" : "inactive",
      evolution: (x.memory || []).slice(-3),
      raw: x
    };
  }

  function workers() {
    const st = S().state;
    return [].concat(
      st.clones.map(normClone),
      st.ghosts.filter(g => g.merged !== "absorbed").map(normGhost),
      st.shells.map(normShell),
      st.executors.map(normExecutor)
    );
  }
  function worker(id) { return workers().find(w => w.id === id) || null; }
  function workersByType(type) { return workers().filter(w => w.type === type); }

  /* ================================================================== *
   * MODULE 3 — Event Bus (the heartbeat)
   * ================================================================== */
  const EVENT_CATEGORIES = {
    spawn: "lifecycle", replicate: "lifecycle", delete: "lifecycle",
    ghost: "product", shell: "content", matrix: "human", queue: "distribution",
    audit: "evolution", upgrade: "evolution", dna: "evolution", repeat: "automation",
    share: "memory", workflow: "automation", integration: "system",
    memory: "memory", api: "system", permission: "system", bridge: "system",
    provider: "intelligence", runtime: "execution", action: "execution",
    knowledge: "knowledge", mission: "mission"
  };
  const PRIORITY = { delete: "high", upgrade: "high", dna: "high", integration: "medium", workflow: "medium" };

  function emit(kind, text, meta) {
    const st = S().state;
    const ev = {
      id: uid("ev"),
      at: Date.now(),
      kind,
      category: EVENT_CATEGORIES[kind] || "system",
      priority: (meta && meta.priority) || PRIORITY[kind] || "normal",
      workerId: (meta && meta.workerId) || null,
      workerName: (meta && meta.workerName) || null,
      text
    };
    st.events.push(ev);
    if (st.events.length > 500) st.events.shift();
    return ev;
  }
  /* Retrofit: store.logMemory calls this, so every action across all four
     phases becomes a first-class Bridge event with zero extra plumbing. */
  function onMemoryLog(kind, text) { emit(kind, text); }

  function events(filter) {
    let list = S().state.events.slice().reverse();
    if (filter) {
      if (filter.category && filter.category !== "all") list = list.filter(e => e.category === filter.category);
      if (filter.priority && filter.priority !== "all") list = list.filter(e => e.priority === filter.priority);
      if (filter.kind && filter.kind !== "all") list = list.filter(e => e.kind === filter.kind);
      if (filter.worker && filter.worker !== "all") {
        const w = worker(filter.worker);
        const name = w ? w.name : null;
        list = list.filter(e => e.workerId === filter.worker || (name && e.text.includes(name)));
      }
      if (filter.time && filter.time !== "all") {
        const spans = { hour: 3600000, day: 86400000, week: 7 * 86400000 };
        const cut = Date.now() - (spans[filter.time] || 0);
        list = list.filter(e => e.at >= cut);
      }
    }
    return list;
  }
  function eventCategories() { return ["all"].concat(Array.from(new Set(Object.values(EVENT_CATEGORIES)))); }

  /* ================================================================== *
   * MODULE 4 — Shared Memory Engine (private / shared / global)
   * ================================================================== */
  const MEMORY_SCOPES = ["private", "shared", "global"];
  function addMemory(input) {
    const st = S().state;
    const m = {
      id: uid("mem"),
      at: Date.now(),
      scope: MEMORY_SCOPES.includes(input.scope) ? input.scope : "shared",
      kind: input.kind || "lesson",          /* lesson | prompt | success | failure | decision */
      workerId: input.workerId || null,
      title: (input.title || "Untitled").trim(),
      body: (input.body || "").trim()
    };
    st.sharedMemory.push(m);
    if (st.sharedMemory.length > 300) st.sharedMemory.shift();
    emit("memory", `Memory stored (${m.scope}/${m.kind}): ${m.title}`, { workerId: m.workerId });
    S().save();
    return m;
  }
  function promoteMemory(id, scope) {
    const m = S().state.sharedMemory.find(x => x.id === id);
    if (!m) return;
    m.scope = scope;
    emit("memory", `Memory "${m.title}" promoted to ${scope} by GOD CORE.`);
    S().save();
  }
  function deleteMemory(id) {
    S().state.sharedMemory = S().state.sharedMemory.filter(x => x.id !== id);
    S().save();
  }
  function searchMemory(q, scope) {
    const st = S().state;
    const needle = (q || "").toLowerCase();
    return st.sharedMemory.filter(m =>
      (!scope || scope === "all" || m.scope === scope) &&
      (!needle || (m.title + " " + m.body + " " + m.kind).toLowerCase().includes(needle))
    ).slice().reverse();
  }

  /* ================================================================== *
   * MODULE 5 — Integration Manager (placeholders — no real APIs, per spec)
   * ================================================================== */
  const DEFAULT_INTEGRATIONS = [
    { key: "openai", name: "OpenAI", group: "AI" },
    { key: "claude", name: "Claude", group: "AI" },
    { key: "gemini", name: "Gemini", group: "AI" },
    { key: "supabase", name: "Supabase", group: "Data" },
    { key: "make", name: "Make.com", group: "Automation" },
    { key: "n8n", name: "n8n", group: "Automation" },
    { key: "vapi", name: "Vapi", group: "Voice" },
    { key: "voiceflow", name: "Voiceflow", group: "Voice" },
    { key: "github", name: "GitHub", group: "Dev" },
    { key: "gmail", name: "Gmail", group: "Comms" },
    { key: "telegram", name: "Telegram", group: "Comms" },
    { key: "discord", name: "Discord", group: "Comms" },
    { key: "stripe", name: "Stripe", group: "Payments" }
  ];
  function ensureIntegrations() {
    const st = S().state;
    st.integrations = st.integrations || [];
    /* top-up: older saves gain newly provisioned cards without losing state */
    DEFAULT_INTEGRATIONS.forEach(i => {
      if (!st.integrations.find(x => x.key === i.key)) {
        st.integrations.push({
          id: uid("int"), key: i.key, name: i.name, group: i.group,
          enabled: false, status: "not_connected", lastSync: null,
          config: "", logs: [`${new Date().toLocaleString()} · card provisioned (placeholder)`]
        });
      }
    });
  }
  function toggleIntegration(id) {
    const it = S().state.integrations.find(i => i.id === id);
    if (!it) return;
    it.enabled = !it.enabled;
    it.status = it.enabled ? "configured" : "not_connected";
    it.logs.push(`${new Date().toLocaleString()} · ${it.enabled ? "enabled" : "disabled"} (placeholder — no live API)`);
    emit("integration", `Integration ${it.name} ${it.enabled ? "enabled" : "disabled"}.`);
    S().save();
  }
  function configureIntegration(id, config) {
    const it = S().state.integrations.find(i => i.id === id);
    if (!it) return;
    it.config = (config || "").trim();
    if (it.config && it.status === "not_connected") it.status = "configured";
    it.logs.push(`${new Date().toLocaleString()} · configuration stored (future API credentials — unused until live APIs connect)`);
    emit("integration", `Integration ${it.name} configured — credentials stored for future use.`);
    S().save();
  }

  function healthCheck(id) {
    const it = S().state.integrations.find(i => i.id === id);
    if (!it) return null;
    /* mock health check — the spec forbids real connections in this phase */
    it.status = it.enabled ? "healthy" : "not_connected";
    it.lastSync = Date.now();
    it.logs.push(`${new Date().toLocaleString()} · health check → ${it.status} (mock)`);
    emit("integration", `Health check on ${it.name}: ${it.status} (mock).`);
    S().save();
    return it.status;
  }

  /* ================================================================== *
   * MODULE 6 — Workflow Registry (simulated execution)
   * ================================================================== */
  const WF_TRIGGERS = ["manual", "on event", "scheduled", "on worker output"];
  function addWorkflow(input) {
    const st = S().state;
    const wf = {
      id: uid("wf"),
      name: (input.name || "Workflow").trim(),
      description: (input.description || "").trim(),
      trigger: input.trigger || "manual",
      workerId: input.workerId || null,
      integrationId: input.integrationId || null,
      steps: input.steps || [],
      expectedResult: (input.expectedResult || "").trim(),
      status: "idle",
      lastRun: null,
      runs: 0,
      successes: 0
    };
    st.workflows.push(wf);
    emit("workflow", `Workflow "${wf.name}" registered.`, { workerId: wf.workerId });
    S().save();
    return wf;
  }
  function workflowsFor(workerId) { return S().state.workflows.filter(w => w.workerId === workerId); }
  function runWorkflow(id) {
    const wf = S().state.workflows.find(w => w.id === id);
    if (!wf) return null;
    /* simulated — real Make.com / n8n execution is a later phase */
    const r = E().rng(E().hashStr(wf.id + ":" + Date.now()));
    const ok = r() > 0.15;
    wf.runs += 1;
    if (ok) wf.successes += 1;
    wf.lastRun = Date.now();
    wf.status = ok ? "success" : "failed";
    emit("workflow", `Workflow "${wf.name}" ${ok ? "completed" : "failed"} (simulated).`, { workerId: wf.workerId, priority: ok ? "normal" : "high" });
    S().save();
    return ok;
  }
  function deleteWorkflow(id) {
    S().state.workflows = S().state.workflows.filter(w => w.id !== id);
    S().save();
  }
  function successRate(wf) { return wf.runs ? Math.round(wf.successes / wf.runs * 100) : 0; }

  /* ================================================================== *
   * STEP 5 — AI Router (real for Claude models)
   * ================================================================== */
  const PROVIDERS = ["Claude", "OpenAI (GPT)", "Gemini", "Multi-model"];
  const CLAUDE_MODELS = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"];
  function defaultRouter() {
    return {
      routes: [
        { id: uid("rt"), category: "Reasoning / strategy", provider: "Claude", model: "claude-opus-4-8" },
        { id: uid("rt"), category: "Copywriting / content", provider: "Claude", model: "claude-sonnet-5" },
        { id: uid("rt"), category: "Fast / bulk tasks", provider: "Claude", model: "claude-haiku-4-5" },
        { id: uid("rt"), category: "Coding", provider: "Claude", model: "claude-opus-4-8" },
        { id: uid("rt"), category: "Research", provider: "Multi-model", model: "claude-opus-4-8" }
      ]
    };
  }
  function router() {
    const st = S().state;
    if (!st.aiRouter) { st.aiRouter = defaultRouter(); S().save(); }
    return st.aiRouter;
  }
  function setRoute(id, patch) {
    const rt = router().routes.find(r => r.id === id);
    if (!rt) return;
    Object.assign(rt, patch);
    emit("bridge", `AI Router: "${rt.category}" → ${rt.provider}${rt.provider === "Claude" || rt.provider === "Multi-model" ? " (" + rt.model + ")" : ""}.`);
    S().save();
  }
  /* Real hook: engine consults this to pick the Claude model for a category.
     Non-Claude providers can't execute (their integrations are placeholders),
     so we fall back to their configured Claude model + flag it. */
  function routeFor(category) {
    const rt = router().routes.find(r => r.category === category) || router().routes[0];
    const usable = rt.provider === "Claude" || rt.provider === "Multi-model";
    return { provider: rt.provider, model: usable && CLAUDE_MODELS.includes(rt.model) ? rt.model : "claude-opus-4-8", executable: usable };
  }

  /* ================================================================== *
   * MODULE 7 — Permission Engine
   * ================================================================== */
  const RESOURCES = ["Workers", "Vaults", "Revenue", "Analytics", "Integrations", "Automation", "Memory"];
  const ROLES = ["Owner", "Administrator", "AI Worker", "Freelancer", "Closer", "Partner", "Affiliate", "Viewer"];
  /* access: full | read | none, per role × resource */
  const MATRIX = {
    Owner:         { Workers: "full", Vaults: "full", Revenue: "full", Analytics: "full", Integrations: "full", Automation: "full", Memory: "full" },
    Administrator: { Workers: "full", Vaults: "full", Revenue: "read", Analytics: "full", Integrations: "full", Automation: "full", Memory: "full" },
    "AI Worker":   { Workers: "read", Vaults: "read", Revenue: "none", Analytics: "read", Integrations: "none", Automation: "read", Memory: "full" },
    Freelancer:    { Workers: "read", Vaults: "none", Revenue: "none", Analytics: "none", Integrations: "none", Automation: "none", Memory: "read" },
    Closer:        { Workers: "read", Vaults: "read", Revenue: "read", Analytics: "read", Integrations: "none", Automation: "none", Memory: "read" },
    Partner:       { Workers: "read", Vaults: "read", Revenue: "read", Analytics: "read", Integrations: "none", Automation: "read", Memory: "read" },
    Affiliate:     { Workers: "none", Vaults: "none", Revenue: "read", Analytics: "read", Integrations: "none", Automation: "none", Memory: "none" },
    Viewer:        { Workers: "read", Vaults: "none", Revenue: "none", Analytics: "read", Integrations: "none", Automation: "none", Memory: "none" }
  };
  function activeRole() { return S().state.activeRole || "Owner"; }
  function setRole(role) {
    if (!ROLES.includes(role)) return;
    S().state.activeRole = role;
    emit("permission", `Active role switched to ${role}.`);
    S().save();
  }
  function access(resource, role) { return (MATRIX[role || activeRole()] || {})[resource] || "none"; }
  function can(resource, action) {
    const a = access(resource);
    if (action === "read") return a === "read" || a === "full";
    return a === "full"; /* write/manage */
  }

  /* ================================================================== *
   * STEP 9 — Internal API Layer
   * Standardized internal endpoints. Every call is logged for the
   * Developer Console — this is the real contract future modules use.
   * ================================================================== */
  function logApi(endpoint, count) {
    const st = S().state;
    st.apiLog.push({ id: uid("ap"), at: Date.now(), endpoint, count });
    if (st.apiLog.length > 100) st.apiLog.shift();
  }
  const api = {
    workers: {
      list: (type) => { const r = type ? workersByType(type) : workers(); logApi(`GET /workers${type ? "?type=" + type : ""}`, r.length); return r; },
      get: (id) => { logApi(`GET /workers/${id}`, 1); return worker(id); }
    },
    tasks: {
      list: () => { const r = S().state.tasks.concat(S().state.mtasks || []); logApi("GET /tasks", r.length); return r; }
    },
    memory: {
      search: (q, scope) => { const r = searchMemory(q, scope); logApi(`GET /memory?q=${q || ""}`, r.length); return r; }
    },
    events: {
      list: (filter) => { const r = events(filter); logApi("GET /events", r.length); return r; }
    },
    analytics: {
      summary: () => { const r = health(); logApi("GET /analytics/summary", 1); return r; }
    },
    vault: {
      list: () => {
        const items = [];
        S().state.clones.forEach(c => (c.vault || []).forEach(v => items.push({ owner: c.name, ownerType: "clone", title: v.title, type: v.type })));
        logApi("GET /vault", items.length);
        return items;
      }
    },
    workflows: {
      list: () => { const r = S().state.workflows; logApi("GET /workflows", r.length); return r; }
    },
    /* Phase Epsilon — Mission Control speaks Bridge API too */
    missions: {
      list: () => {
        const MS = window.PRISM && PRISM.missions ? PRISM.missions : null;
        const r = MS ? MS.missions().map(m => ({ id: m.id, name: m.name, status: m.status, progress: MS.progress(m), tasks: m.tasks.length, health: MS.health(m) })) : [];
        logApi("GET /missions", r.length);
        return r;
      }
    },
    /* Phase Delta — the Knowledge Network speaks Bridge API too */
    knowledge: {
      list: () => {
        const K = window.PRISM && PRISM.knowledge ? PRISM.knowledge : null;
        const r = K ? K.docs().map(d => ({ id: d.id, title: d.title, category: d.category, layer: d.layer, type: d.type, confidence: K.confidence(d), uses: d.uses })) : [];
        logApi("GET /knowledge", r.length);
        return r;
      },
      search: (q) => {
        const K = window.PRISM && PRISM.knowledge ? PRISM.knowledge : null;
        const r = K ? K.search(q || "").map(h => ({ title: h.doc.title, matched: h.matched, score: +h.score.toFixed(2) })) : [];
        logApi(`GET /knowledge/search?q=${q || ""}`, r.length);
        return r;
      }
    },
    /* Phase Gamma — the Execution Layer speaks Bridge API too */
    actions: {
      list: () => {
        const X = window.PRISM && PRISM.execution ? PRISM.execution : null;
        const r = X ? X.actions().map(a => ({ id: a.id, label: a.label, integration: a.integrationName, category: a.category })) : [];
        logApi("GET /actions", r.length);
        return r;
      }
    },
    executions: {
      list: () => {
        const X = window.PRISM && PRISM.execution ? PRISM.execution : null;
        const r = X ? X.history().slice(0, 25) : [];
        logApi("GET /executions", r.length);
        return r;
      }
    },
    /* Phase H0 — the Intelligence Provider Layer speaks Bridge API too */
    providers: {
      list: () => {
        const P = window.PRISM && PRISM.providers ? PRISM.providers : null;
        const r = P ? P.list().map(p => ({ id: p.id, name: p.name, version: p.version, priority: p.priority, enabled: p.enabled, health: P.healthOf(p.id) })) : [];
        logApi("GET /providers", r.length);
        return r;
      },
      analytics: () => {
        const P = window.PRISM && PRISM.providers ? PRISM.providers : null;
        const r = P ? P.list().map(p => P.analyticsOf(p.id)) : [];
        logApi("GET /providers/analytics", r.length);
        return r;
      }
    }
  };
  const API_ENDPOINTS = ["GET /workers", "GET /workers/:id", "GET /tasks", "GET /memory", "GET /events", "GET /analytics/summary", "GET /vault", "GET /workflows", "GET /providers", "GET /providers/analytics", "GET /actions", "GET /executions", "GET /knowledge", "GET /knowledge/search", "GET /missions"];

  /* ================================================================== *
   * MODULE 2 — Bridge dispatch (single routing choke point)
   * ================================================================== */
  function dispatch(action, payload) {
    const st = S().state;
    st.bridgeReady = true;
    emit("bridge", `Bridge routed: ${action}`, payload || {});
    return { ok: true, action, at: Date.now() };
  }

  /* ================================================================== *
   * MODULE 8 — System Health
   * ================================================================== */
  function health() {
    const st = S().state;
    const ws = workers();
    const wfRuns = st.workflows.reduce((a, w) => a + w.runs, 0);
    const wfOk = st.workflows.reduce((a, w) => a + w.successes, 0);
    const failedEvents = st.events.filter(e => /fail/i.test(e.text)).length;
    return {
      bridge: st.bridgeReady ? "online" : "initializing",
      workers: ws.length,
      byType: {
        clone: st.clones.length,
        ghost: st.ghosts.filter(g => g.merged !== "absorbed").length,
        shell: st.shells.length,
        executor: st.executors.filter(x => x.active).length
      },
      workflows: st.workflows.length,
      runningWorkflows: st.workflows.filter(w => w.status === "success" || w.status === "idle").length,
      failedTasks: failedEvents,
      integrations: { total: st.integrations.length, enabled: st.integrations.filter(i => i.enabled).length, healthy: st.integrations.filter(i => i.status === "healthy").length },
      memory: st.sharedMemory.length,
      events: st.events.length,
      throughput: st.events.filter(e => Date.now() - e.at < 3600000).length,
      successRate: wfRuns ? Math.round(wfOk / wfRuns * 100) : 100,
      revenue: ws.reduce((a, w) => a + (w.revenue || 0), 0),
      role: activeRole()
    };
  }

  /* ================================================================== *
   * Boot: initialize placeholders + mark the Bridge online
   * ================================================================== */
  function boot() {
    ensureIntegrations();
    router();
    S().state.bridgeReady = true;
    S().save();
  }

  return {
    WORKER_TYPES, MEMORY_SCOPES, WF_TRIGGERS, PROVIDERS, CLAUDE_MODELS,
    RESOURCES, ROLES, MATRIX, EVENT_CATEGORIES, API_ENDPOINTS,
    boot, dispatch, onMemoryLog,
    workers, worker, workersByType,
    emit, events, eventCategories,
    addMemory, promoteMemory, deleteMemory, searchMemory,
    ensureIntegrations, toggleIntegration, healthCheck, configureIntegration,
    addWorkflow, workflowsFor, runWorkflow, deleteWorkflow, successRate,
    router, setRoute, routeFor,
    activeRole, setRole, access, can,
    api, health
  };
})();
