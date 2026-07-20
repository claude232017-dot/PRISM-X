/* PRISM-X — extensions.js
 * PHASE THETA — EXTENSION ECOSYSTEM.
 *
 * PRISM-X becomes a platform: every future capability ships as an
 * extension that installs, updates, configures and uninstalls through the
 * Extension Manager — the core never changes. Extensions follow one SDK
 * (manifest + permissions + scoped APIs + event listeners + UI mounts),
 * subscribe to a pub/sub Event Bus tapped off the Bridge, and touch the
 * system ONLY through permission-scoped public APIs.
 *
 * Honesty line: in a same-page browser runtime the API contract is
 * convention-enforced, not sandbox-enforced (a hostile extension could
 * still reach window.PRISM — iframe sandboxing is the future hardening;
 * the Developer Console says exactly this). Today's catalog is private,
 * owner-authored extensions; the architecture leaves room for community
 * ones without redesign.
 */
window.PRISM = window.PRISM || {};

PRISM.extensions = (function () {
  "use strict";
  const S = () => PRISM.store;
  const B = () => PRISM.bridge;
  const K = () => PRISM.knowledge;
  const MS = () => PRISM.missions;
  const EN = () => PRISM.enterprise;
  const P = () => PRISM.providers;
  const X = () => PRISM.execution;

  const CORE_VERSION = "1.0.0";
  const PERMISSIONS = [
    "Read Knowledge", "Store Knowledge", "Read Missions", "Modify Missions",
    "Access CRM", "Trigger Automations", "Read Revenue", "Manage Organizations",
    "Access Workers", "Access Integrations", "Access Events"
  ];
  const CATEGORIES = ["AI Workers", "Business Templates", "Automation Packs", "CRM Modules", "Finance Modules", "Analytics Packs", "Marketing Tools", "Custom Providers", "Integrations", "Industry Solutions"];
  const EVENTS = ["MissionCompleted", "WorkerStarted", "WorkerCreated", "KnowledgeStored", "ClientCreated", "PaymentReceived", "WorkflowFinished", "ProviderConnected", "ActionExecuted", "ImprovementProposed"];

  /* in-memory (not persisted): bus ring, per-ext logs, perf, subscriptions */
  const busRing = [];
  const logs = {};   /* extId → [{at, text}] */
  const perf = {};   /* extId → {calls, ms, errors} */
  let subs = {};     /* eventName → [{extId, fn}] */

  function log(extId, text) {
    (logs[extId] = logs[extId] || []).push({ at: Date.now(), text: String(text).slice(0, 200) });
    if (logs[extId].length > 60) logs[extId].shift();
  }

  /* ================================================================== *
   * MODULE 4 — internal Event Bus (pub/sub, tapped off the Bridge)
   * ================================================================== */
  function publish(name, payload) {
    busRing.push({ at: Date.now(), name, payload: payload && payload.text ? String(payload.text).slice(0, 120) : "" });
    if (busRing.length > 60) busRing.shift();
    (subs[name] || []).forEach(s2 => {
      const t0 = performance.now();
      const p2 = perf[s2.extId] = perf[s2.extId] || { calls: 0, ms: 0, errors: 0 };
      try {
        s2.fn(payload, api(s2.extId));
        p2.calls += 1;
        log(s2.extId, `listener ${name} fired`);
      } catch (err) {
        p2.errors += 1;
        log(s2.extId, `listener ${name} ERROR: ${err.message}`);
      }
      p2.ms += performance.now() - t0;
    });
  }
  /* one-line core tap: bridge.emit forwards every system event here */
  function onCoreEvent(ev) {
    publish("core:" + ev.kind, ev);
    const t = ev.text || "";
    if (ev.kind === "mission" && /COMPLETED/.test(t)) publish("MissionCompleted", ev);
    if (ev.kind === "runtime" && /Execution started/.test(t)) publish("WorkerStarted", ev);
    if (ev.kind === "spawn") publish("WorkerCreated", ev);
    if (ev.kind === "knowledge" && /Knowledge stored/.test(t)) publish("KnowledgeStored", ev);
    if (ev.kind === "org" && /new (lead|qualified|proposal)/.test(t)) publish("ClientCreated", ev);
    if (ev.kind === "org" && /Ledger — revenue/.test(t)) publish("PaymentReceived", ev);
    if (ev.kind === "workflow" && /(completed|success|registered)/i.test(t)) publish("WorkflowFinished", ev);
    if (ev.kind === "provider" && /(enabled|configured)/.test(t)) publish("ProviderConnected", ev);
    if (ev.kind === "action" && /Action completed/.test(t)) publish("ActionExecuted", ev);
    if (ev.kind === "evolve" && /proposed/.test(t)) publish("ImprovementProposed", ev);
  }

  /* ================================================================== *
   * MODULE 5 + 6 — permission-scoped public API layer
   * ================================================================== */
  function granted(extId) {
    if (extId === "dev-console") return PERMISSIONS.slice();
    const rec = stateOf(extId);
    return rec ? rec.granted || [] : [];
  }
  function need(extId, perm) {
    if (!granted(extId).includes(perm)) {
      log(extId, `DENIED — missing permission "${perm}"`);
      throw new Error(`Extension "${extId}" lacks permission "${perm}"`);
    }
  }
  function api(extId) {
    return {
      /* extensions interact ONLY through these facades — never raw state */
      missions: {
        list: () => { need(extId, "Read Missions"); return B().api.missions.list(); },
        create: (input) => { need(extId, "Modify Missions"); return MS().plan(input || {}); }
      },
      workers: {
        list: () => { need(extId, "Access Workers"); return B().api.workers.list(); }
      },
      knowledge: {
        search: (q) => { need(extId, "Read Knowledge"); return B().api.knowledge.search(q); },
        top: (q, n) => { need(extId, "Read Knowledge"); return K().search(q || "", { limit: n || 3 }).map(h => ({ title: h.doc.title, excerpt: h.doc.body.slice(0, 200) })); },
        add: (input) => { need(extId, "Store Knowledge"); return K().addDoc(Object.assign({}, input, { source: "extension:" + extId })); }
      },
      providers: {
        list: () => { need(extId, "Access Workers"); return B().api.providers.list(); }
      },
      integrations: {
        actions: () => { need(extId, "Access Integrations"); return B().api.actions.list(); }
      },
      automations: {
        run: (autId, clientId) => { need(extId, "Trigger Automations"); return EN().runAutomation(autId, clientId); }
      },
      crm: {
        list: () => { need(extId, "Access CRM"); return EN().clients().map(c => ({ id: c.id, name: c.name, company: c.company, stage: c.stage })); },
        stages: () => { need(extId, "Access CRM"); return EN().STAGES.slice(); }
      },
      revenue: {
        stats: () => { need(extId, "Read Revenue"); return EN().financeStats(null); }
      },
      organizations: {
        list: () => { need(extId, "Manage Organizations"); return EN().orgs().map(o => ({ id: o.id, name: o.name, industry: o.industry, status: o.status })); }
      },
      events: {
        recent: () => { need(extId, "Access Events"); return busRing.slice(-20); },
        emit: (text) => { B().emit("extension", `📦 [${extId}] ` + String(text).slice(0, 160)); },
        runtime: () => { need(extId, "Access Events"); return { queue: S().dueQueue().length, missionsReady: MS().missions().filter(m => m.status === "active").length, evals: PRISM.runtime ? PRISM.runtime.waitingTasks().length : 0 }; }
      },
      config: () => (stateOf(extId) || {}).config || {},
      log: (text) => log(extId, text)
    };
  }

  /* ================================================================== *
   * MODULE 3 — the SDK: every extension is a manifest of this shape
   * ================================================================== */
  function validate(m) {
    const problems = [];
    ["id", "name", "version", "author", "category", "description", "requires"].forEach(k2 => { if (!m[k2]) problems.push("missing " + k2); });
    if (!Array.isArray(m.permissions)) problems.push("permissions must be an array");
    if (!Array.isArray(m.requiredApis)) problems.push("requiredApis must be an array");
    if (!Array.isArray(m.dependencies)) problems.push("dependencies must be an array");
    if (!m.docs) problems.push("missing docs");
    if (m.permissions && m.permissions.some(p2 => !PERMISSIONS.includes(p2))) problems.push("unknown permission requested");
    return { ok: !problems.length, problems };
  }

  /* ================================================================== *
   * The private catalog — owner-authored extensions with REAL behavior.
   * (Community extensions later: same SDK, same manager, zero redesign.)
   * ================================================================== */
  const CATALOG = [
    {
      id: "pulse-widget", name: "System Pulse", version: "1.1.0", author: "GOD CORE",
      category: "Analytics Packs", requires: "1.0.0", dependencies: [],
      description: "A dashboard widget with the live heartbeat: recent bus events, active missions, pending evaluations.",
      permissions: ["Access Events"], requiredApis: ["events"],
      configSchema: [{ key: "title", label: "Widget title", def: "SYSTEM PULSE" }],
      docs: "Mounts one dashboard widget. Reads only the Event API. Config: widget title.",
      ui: {
        widgets: [{
          id: "pulse", title: (a) => (a.config().title || "SYSTEM PULSE"),
          mount: (el2, a) => {
            const rt = a.events.runtime();
            const evs = a.events.recent().slice(-4).reverse();
            el2.innerHTML = "";
            el2.appendChild(PRISM.ui.el("div", { class: "dim small-note", text: `${rt.missionsReady} active mission(s) · ${rt.evals} evaluation(s) waiting · ${rt.queue} post(s) due` }));
            evs.forEach(e2 => el2.appendChild(PRISM.ui.el("div", { class: "tiny-note dim", text: `• ${e2.name}${e2.payload ? " — " + e2.payload.slice(0, 60) : ""}` })));
          }
        }],
        pages: []
      },
      listeners: {},
      init: (a) => a.log("System Pulse online")
    },
    {
      id: "crm-pulse", name: "CRM Pulse", version: "1.0.0", author: "GOD CORE",
      category: "CRM Modules", requires: "1.0.0", dependencies: ["pulse-widget"],
      description: "Pipeline funnel widget + logs every new client the moment the CRM sees them.",
      permissions: ["Access CRM"], requiredApis: ["crm"],
      configSchema: [],
      docs: "Depends on System Pulse. One dashboard widget (funnel counts) + ClientCreated listener.",
      ui: {
        widgets: [{
          id: "funnel", title: () => "CRM FUNNEL",
          mount: (el2, a) => {
            const cs = a.crm.list();
            el2.innerHTML = "";
            a.crm.stages().forEach(s2 => {
              const n = cs.filter(c => c.stage === s2).length;
              if (n) el2.appendChild(PRISM.ui.el("div", { class: "small-note", text: `${s2}: ${n}` }));
            });
            if (!cs.length) el2.appendChild(PRISM.ui.el("div", { class: "dim tiny-note", text: "pipeline empty" }));
          }
        }],
        pages: []
      },
      listeners: {
        ClientCreated: (ev, a) => a.log("New client observed: " + (ev.text || "").slice(0, 80))
      },
      init: (a) => a.log("CRM Pulse online")
    },
    {
      id: "ledger-guard", name: "Ledger Guard", version: "1.0.0", author: "GOD CORE",
      category: "Finance Modules", requires: "1.0.0", dependencies: [],
      description: "Watches the ledger and raises an alert event when a single expense crosses your threshold.",
      permissions: ["Read Revenue", "Access Events"], requiredApis: ["revenue", "events"],
      configSchema: [{ key: "threshold", label: "Expense alert threshold ($)", def: "500" }],
      docs: "Listens to core:org ledger events; when an expense exceeds the configured threshold it emits an alert into the Command Center.",
      ui: { widgets: [], pages: [] },
      listeners: {
        "core:org": (ev, a) => {
          const m = /expense \$([0-9,]+)/.exec(ev.text || "");
          if (!m) return;
          const amt = parseInt(m[1].replace(/,/g, ""), 10);
          const thr = parseInt(a.config().threshold || "500", 10);
          if (amt >= thr) {
            a.events.emit(`⚠ Ledger Guard: expense $${amt} ≥ threshold $${thr} — review recommended.`);
            a.log(`ALERT expense $${amt} ≥ $${thr}`);
          }
        }
      },
      init: (a) => a.log("Ledger Guard armed (threshold $" + (a.config().threshold || "500") + ")")
    },
    {
      id: "mission-narrator", name: "Mission Narrator", version: "1.0.0", author: "GOD CORE",
      category: "Automation Packs", requires: "1.0.0", dependencies: [],
      description: "Every completed mission automatically becomes a recap document in the Knowledge Vault.",
      permissions: ["Read Missions", "Store Knowledge"], requiredApis: ["missions", "knowledge"],
      configSchema: [],
      docs: "Subscribes to MissionCompleted; writes 'Mission recap — …' docs via the Knowledge API (source extension:mission-narrator).",
      ui: { widgets: [], pages: [] },
      listeners: {
        MissionCompleted: (ev, a) => {
          const title = ("Mission recap — " + (ev.text || "mission").replace(/^🎯\s*Mission COMPLETED —\s*/, "")).slice(0, 100);
          a.knowledge.add({ title, body: ev.text || "", type: "note", category: "Business", layer: "operational", tags: ["recap"] });
          a.log("Recap stored: " + title.slice(0, 60));
        }
      },
      init: (a) => a.log("Mission Narrator listening")
    },
    {
      id: "linkedin-pack", name: "LinkedIn Composer Pack", version: "1.0.0", author: "GOD CORE",
      category: "Marketing Tools", requires: "1.0.0", dependencies: [],
      description: "A sidebar page that turns your best vault lessons into LinkedIn-style post drafts (copy-paste ready).",
      permissions: ["Read Knowledge"], requiredApis: ["knowledge"],
      configSchema: [{ key: "hookStyle", label: "Hook style", def: "contrarian" }],
      docs: "Adds the 'LinkedIn Composer' page. Pulls top vault lessons and formats platform-native drafts locally.",
      ui: {
        widgets: [],
        pages: [{
          id: "composer", title: "LinkedIn Composer", icon: "💼",
          render: (el2, a) => {
            const U2 = PRISM.ui;
            const topic = U2.el("input", { class: "input", placeholder: "post topic, e.g. cold email lessons" });
            const out = U2.el("pre", { class: "output-pre", text: "// draft appears here" });
            el2.appendChild(U2.el("div", { class: "panel form-panel" }, [
              U2.el("div", { class: "panel-head" }, [U2.el("h2", { class: "panel-title", text: "💼 LinkedIn Composer" })]),
              U2.el("label", { class: "field" }, [U2.el("span", { class: "field-label", text: "Topic" }), topic]),
              U2.el("div", { class: "form-actions" }, [U2.el("button", { class: "btn primary", text: "Compose from vault", onclick: () => {
                const hits = a.knowledge.top(topic.value || "lesson", 2);
                const hook = (a.config().hookStyle === "contrarian") ? "Unpopular opinion:" : "Here's what nobody tells you:";
                out.textContent = [
                  hook + " most people get " + (topic.value || "this") + " backwards.",
                  "",
                  ...hits.map(h => "→ " + h.title + "\n  " + h.excerpt.split("\n")[0]),
                  "",
                  "I learned this running an AI-operated business system.",
                  "",
                  "♻ Repost if useful. Follow for the build log."
                ].join("\n");
                a.log("Draft composed on: " + (topic.value || "lesson"));
              } })]),
              out
            ]));
          }
        }]
      },
      listeners: {},
      init: (a) => a.log("LinkedIn Composer ready")
    },
    {
      id: "focus-page", name: "Daily Focus", version: "1.0.0", author: "GOD CORE",
      category: "Industry Solutions", requires: "1.0.0", dependencies: [],
      description: "One page with everything that needs you right now: due posts, ready mission tasks, waiting evaluations.",
      permissions: ["Access Events", "Read Missions"], requiredApis: ["events", "missions"],
      configSchema: [],
      docs: "Adds the 'Daily Focus' page aggregating actionables from across the OS via the Event + Mission APIs.",
      ui: {
        widgets: [],
        pages: [{
          id: "focus", title: "Daily Focus", icon: "🎯",
          render: (el2, a) => {
            const U2 = PRISM.ui;
            const rt = a.events.runtime();
            const ms2 = a.missions.list().filter(m => m.status === "active");
            el2.appendChild(U2.el("div", { class: "panel" }, [
              U2.el("div", { class: "panel-head" }, [U2.el("h2", { class: "panel-title", text: "🎯 Needs you now" })]),
              U2.el("div", { class: "act-row" }, [U2.el("b", { text: "Broadcast Queue" }), U2.el("span", { class: "dim small-note", text: rt.queue + " post(s) due" })]),
              U2.el("div", { class: "act-row" }, [U2.el("b", { text: "Runtime evaluations" }), U2.el("span", { class: "dim small-note", text: rt.evals + " waiting for your score" })]),
              ...ms2.map(m => U2.el("div", { class: "act-row" }, [U2.el("b", { text: m.name }), U2.el("span", { class: "dim small-note", text: m.progress + "% — keep it moving" })]))
            ]));
          }
        }]
      },
      listeners: {},
      init: (a) => a.log("Daily Focus ready")
    },
    {
      id: "quantum-provider", name: "Quantum Provider Bridge", version: "0.9.0", author: "GOD CORE",
      category: "Custom Providers", requires: "2.0.0", dependencies: [],
      description: "A future-core provider bridge — deliberately requires core 2.0 to demonstrate honest version gating.",
      permissions: ["Access Workers"], requiredApis: ["providers"],
      configSchema: [],
      docs: "Cannot install on core 1.0 — the manager refuses incompatible versions instead of pretending.",
      ui: { widgets: [], pages: [] },
      listeners: {},
      init: () => {}
    }
  ];
  function catalog() { return CATALOG; }
  function manifest(id) { return CATALOG.find(m => m.id === id) || null; }

  /* ================================================================== *
   * MODULE 2 + 8 — Extension Manager + Registry (persisted state)
   * ================================================================== */
  function ensure() {
    const st = S().state;
    st.extensionsState = st.extensionsState || {};
    return st.extensionsState;
  }
  function stateOf(id) { return ensure()[id] || null; }
  function installed() { return Object.keys(ensure()).map(id => Object.assign({ id }, ensure()[id], { manifest: manifest(id) })).filter(x => x.manifest); }
  function isActive(id) {
    const r = stateOf(id);
    return !!(r && r.enabled && r.approved);
  }
  function cmpVersion(a, b2) {
    const pa = a.split(".").map(Number), pb = b2.split(".").map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
    return 0;
  }
  function emit(text, meta) { B().emit("extension", "📦 " + text, meta || {}); }

  function install(id, version) {
    const m = manifest(id);
    if (!m) return { ok: false, reason: "unknown extension" };
    const v = validate(m);
    if (!v.ok) return { ok: false, reason: "SDK validation failed: " + v.problems.join(", ") };
    if (cmpVersion(CORE_VERSION, m.requires) < 0) return { ok: false, reason: `incompatible — requires core ${m.requires}, running ${CORE_VERSION}` };
    for (const dep of m.dependencies) {
      if (!stateOf(dep)) return { ok: false, reason: `dependency missing — install "${dep}" first` };
    }
    const es = ensure();
    if (es[id]) return { ok: false, reason: "already installed" };
    const cfg = {};
    (m.configSchema || []).forEach(f => { cfg[f.key] = f.def || ""; });
    es[id] = {
      version: version || (id === "pulse-widget" ? "1.0.0" : m.version), /* pulse ships 1.0 so the update path is real */
      enabled: true,
      approved: m.permissions.length === 0,
      granted: m.permissions.length === 0 ? [] : [],
      config: cfg,
      installedAt: Date.now(),
      updateHistory: [{ at: Date.now(), note: "installed v" + (version || (id === "pulse-widget" ? "1.0.0" : m.version)) }],
      health: "ok"
    };
    log(id, "installed");
    if (es[id].approved) activate(id);
    emit(`${m.name} installed${m.permissions.length ? " — awaiting permission approval (" + m.permissions.join(", ") + ")" : " and activated"}.`, { priority: "medium" });
    S().save();
    return { ok: true, pendingApproval: !es[id].approved };
  }
  /* MODULE 6 — owner approval gates activation */
  function approve(id) {
    const r = stateOf(id);
    const m = manifest(id);
    if (!r || !m || r.approved) return false;
    r.approved = true;
    r.granted = m.permissions.slice();
    activate(id);
    emit(`${m.name} approved — permissions granted: ${m.permissions.join(", ") || "none"}. Extension active.`, { priority: "medium" });
    S().save();
    return true;
  }
  function activate(id) {
    const m = manifest(id);
    if (!m || !isActive(id)) return;
    subs = rebuildSubs();
    try { if (m.init) m.init(api(id)); } catch (err) { log(id, "init ERROR: " + err.message); ensure()[id].health = "error"; }
  }
  function rebuildSubs() {
    const out = {};
    installed().filter(x => isActive(x.id)).forEach(x => {
      Object.entries(x.manifest.listeners || {}).forEach(([name, fn]) => {
        (out[name] = out[name] || []).push({ extId: x.id, fn });
      });
    });
    return out;
  }
  function setEnabled(id, on) {
    const r = stateOf(id);
    if (!r) return false;
    r.enabled = !!on;
    subs = rebuildSubs();
    log(id, on ? "enabled" : "disabled");
    emit(`${manifest(id).name} ${on ? "enabled" : "disabled"}.`);
    S().save();
    return true;
  }
  function uninstall(id) {
    const es = ensure();
    if (!es[id]) return { ok: false, reason: "not installed" };
    const dependents = installed().filter(x => x.id !== id && (x.manifest.dependencies || []).includes(id));
    if (dependents.length) return { ok: false, reason: `blocked — ${dependents.map(d2 => d2.manifest.name).join(", ")} depend(s) on it` };
    const m = manifest(id);
    try { if (m.teardown) m.teardown(api(id)); } catch (_) {}
    delete es[id];
    subs = rebuildSubs();
    emit(`${m.name} uninstalled — core untouched.`);
    S().save();
    return { ok: true };
  }
  function updateAvailable(id) {
    const r = stateOf(id), m = manifest(id);
    return !!(r && m && cmpVersion(m.version, r.version) > 0);
  }
  function update(id) {
    const r = stateOf(id), m = manifest(id);
    if (!r || !m || !updateAvailable(id)) return false;
    const from = r.version;
    r.version = m.version;
    r.updateHistory.push({ at: Date.now(), note: `updated v${from} → v${m.version}` });
    log(id, `updated ${from} → ${m.version}`);
    emit(`${m.name} updated v${from} → v${m.version}.`, { priority: "medium" });
    S().save();
    return true;
  }
  function setConfig(id, cfg) {
    const r = stateOf(id);
    if (!r) return false;
    r.config = Object.assign({}, r.config, cfg || {});
    log(id, "configuration updated");
    S().save();
    return true;
  }

  /* ================================================================== *
   * MODULE 7 — UI framework: mounted widgets + registered pages
   * ================================================================== */
  function widgets() {
    return installed().filter(x => isActive(x.id)).flatMap(x =>
      ((x.manifest.ui && x.manifest.ui.widgets) || []).map(w => ({ extId: x.id, extName: x.manifest.name, widget: w }))
    );
  }
  function pages() {
    return installed().filter(x => isActive(x.id)).flatMap(x =>
      ((x.manifest.ui && x.manifest.ui.pages) || []).map(pg => ({ extId: x.id, extName: x.manifest.name, page: pg }))
    );
  }
  function page(extId, pageId) {
    const hit = pages().find(x => x.extId === extId && x.page.id === pageId);
    return hit || null;
  }

  /* ================================================================== *
   * MODULE 9 — developer console data
   * ================================================================== */
  function devData() {
    return {
      coreVersion: CORE_VERSION,
      apis: ["missions", "workers", "knowledge", "providers", "integrations", "automations", "crm", "revenue", "organizations", "events", "config", "log"],
      busRing: busRing.slice().reverse(),
      logs, perf,
      permissions: installed().map(x => ({ id: x.id, name: x.manifest.name, requested: x.manifest.permissions, granted: x.granted || [], approved: x.approved })),
      contractNote: "API contract is convention-enforced in a same-page runtime — a hostile extension could still reach window.PRISM. Iframe sandboxing is the planned hardening; install only extensions you trust (today: owner-authored only)."
    };
  }
  /* sandbox: run a snippet against a fully-granted API (owner tool) */
  function sandbox(code) {
    try {
      const fn = new Function("api", code);
      const res = fn(api("dev-console"));
      return { ok: true, result: typeof res === "undefined" ? "(no return value)" : JSON.stringify(res, null, 2).slice(0, 1500) };
    } catch (err) {
      return { ok: false, result: "Error: " + err.message };
    }
  }

  function stats() {
    const inst = installed();
    return {
      installed: inst.length,
      active: inst.filter(x => isActive(x.id)).length,
      disabled: inst.filter(x => !x.enabled).length,
      pending: inst.filter(x => !x.approved).length,
      updates: inst.filter(x => updateAvailable(x.id)).length,
      available: CATALOG.length - inst.length,
      recent: inst.slice().sort((a, b2) => b2.installedAt - a.installedAt).slice(0, 3)
    };
  }

  function boot() {
    ensure();
    /* startup initialization: every enabled+approved extension loads through the manager */
    subs = rebuildSubs();
    installed().filter(x => isActive(x.id)).forEach(x => {
      try { if (x.manifest.init) x.manifest.init(api(x.id)); } catch (err) { log(x.id, "init ERROR: " + err.message); }
    });
    const st = S().state;
    if (!st.extensionsReady && st.onboarded) {
      st.extensionsReady = true;
      emit(`Extension Ecosystem online — ${CATALOG.length} private extensions in the catalog, core v${CORE_VERSION} stays frozen while the platform grows.`, { priority: "medium" });
      S().save();
    }
  }

  return {
    CORE_VERSION, PERMISSIONS, CATEGORIES, EVENTS,
    catalog, manifest, validate,
    ensure, stateOf, installed, isActive,
    install, approve, setEnabled, uninstall, update, updateAvailable, setConfig,
    publish, onCoreEvent, api,
    widgets, pages, page,
    devData, sandbox, stats, boot
  };
})();
