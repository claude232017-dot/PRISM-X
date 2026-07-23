/* PRISM-X — store.js
 * Single source of truth. Persisted to localStorage. No backend required.
 */
window.PRISM = window.PRISM || {};

PRISM.store = (function () {
  "use strict";
  const KEY = "prismx_state_v1";
  const E = () => PRISM.engine;

  const defaults = () => ({
    version: 1,
    onboarded: false,
    dna: { tone: "", mindset: "", logic: "", decision: "", cta: "" },
    settings: { engine: "local", apiKey: "", model: "claude-opus-4-8", sound: false, compact: false, digests: true, sessionTimeoutMin: 60, envProfile: "development" },
    godBrainVersion: 1,
    clones: [],
    tasks: [],
    queue: [],
    ghosts: [],
    products: [],
    shells: [],
    executors: [],
    mtasks: [],
    ledger: [],
    superFunnels: [],
    matrixConfig: { reinvestPct: 50 },
    reinvestPool: 0,
    vaultBalance: 0,
    matrixLastRun: null,
    ghostSimOffset: 0,
    /* Phase Alpha — Foundation Protocol (PRISM-X Bridge) */
    events: [],
    sharedMemory: [],
    integrations: [],
    workflows: [],
    aiRouter: null,
    activeRole: "Owner",
    apiLog: [],
    bridgeReady: false,
    systemMemory: [],
    lastAudit: null,
    pendingUpgrade: null,
    lastReport: null,
    /* Phase H0 — Intelligence Provider Layer */
    providers: [],
    customProviders: [],
    providerLayerReady: false,
    /* Phase Beta — First Intelligence (Worker Runtime Engine) */
    runtime: { workerId: null, objective: "", queue: [], executions: [], activatedAt: null },
    /* Phase Gamma — Real-World Execution Layer */
    execHistory: [],
    execPerms: {},
    credVault: { salt: null, entries: {} },
    execLayerReady: false,
    /* Phase Delta — Knowledge & Memory Network */
    knowledge: { docs: [], links: [] },
    knowledgeReady: false,
    /* Phase Epsilon — Autonomous Orchestration */
    missions: [],
    missionTemplatesCustom: [],
    /* Phase Zeta — Evolution Engine */
    evolution: { suggestions: [], experiments: [], timeline: [], scoreHistory: { system: [], workers: {} }, lastAnalyzeAt: null },
    evolutionReady: false,
    /* Phase Eta — Enterprise Operating System */
    enterprise: { orgs: [], clients: [], projects: [], automations: [], finance: [], reports: [] },
    enterpriseReady: false,
    /* Phase Theta — Extension Ecosystem */
    extensionsState: {},
    extensionsReady: false,
    /* Phase Iota — Distributed Intelligence Network */
    network: { nodes: [], syncLog: [], federation: {}, snapshotsMeta: [], nodeAssignments: {}, bootAt: 0 },
    networkReady: false,
    /* Phase Omega — Production Readiness */
    security: { enabled: false, passHash: null, passSalt: null, session: null, authLog: [] },
    readinessReports: [],
    omegaReady: false,
    /* Phase Ω-1 — PRISM-X Academy (in-app learning) */
    academy: { checklist: {} }
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      const merged = Object.assign(defaults(), parsed);
      /* deep-merge nested objects so saves from older versions gain new fields */
      merged.dna = Object.assign(defaults().dna, parsed.dna || {});
      merged.settings = Object.assign(defaults().settings, parsed.settings || {});
      return merged;
    } catch (e) {
      console.warn("PRISM-X: state reset (corrupt save)", e);
      return defaults();
    }
  }

  /* Phase Omega performance: mutations coalesce into one trailing write
   * (the full-state JSON is a few hundred KB — writing it on every single
   * mutation was the hottest path in the app). flush() forces an
   * immediate write; suspendSaves() arms restore/reset flows against a
   * pending timer resurrecting replaced state. */
  let saveTimer = null, savesSuspended = false;
  const saveStatsData = { writes: 0, coalesced: 0, totalMs: 0, lastBytes: 0 };
  function persist() {
    if (savesSuspended) return;
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    try {
      const json = JSON.stringify(state);
      localStorage.setItem(KEY, json);
      saveStatsData.lastBytes = json.length;
      saveStatsData.writes += 1;
      saveStatsData.totalMs += (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    } catch (e) { console.error("PRISM-X: save failed", e); }
  }
  function save(immediate) {
    if (savesSuspended) return;
    if (immediate) {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      persist();
      return;
    }
    if (saveTimer) { saveStatsData.coalesced += 1; return; }
    saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 150);
  }
  function flush() { save(true); }
  function suspendSaves() {
    savesSuspended = true;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  }
  function saveStats() {
    return {
      writes: saveStatsData.writes,
      coalesced: saveStatsData.coalesced,
      avgMs: saveStatsData.writes ? +(saveStatsData.totalMs / saveStatsData.writes).toFixed(1) : 0,
      lastKB: Math.round(saveStatsData.lastBytes / 1024)
    };
  }

  function uid(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------- clones ---------------- */
  function newClone(input) {
    return {
      id: uid("cl"),
      name: (input.name || "UNNAMED").trim(),
      role: input.role,
      tone: input.tone,
      target: input.target || "",
      mindset: input.mindset || "",
      skills: input.skills || "",
      learningSource: input.learningSource || "Use GOD CORE DNA",
      provider: input.provider || "auto",
      createdAt: Date.now(),
      generation: input.generation || 1,
      brainVersion: state.godBrainVersion,
      lastTaskAt: null,
      learnUntil: Date.now() + 30000,
      stats: { earnings: 0, leads: 0, tasks: 0, ratingSum: 0, ratingCount: 0 },
      ratingLog: [],
      daily: {},
      memory: input.memory ? input.memory.slice() : [],
      vault: []
    };
  }

  function addClone(input) {
    const c = newClone(input);
    if (c.learningSource === "Use GOD CORE DNA" && state.dna.mindset) {
      c.memory.push(`Inherited GOD CORE DNA (brain v${state.godBrainVersion}).`);
    }
    state.clones.push(c);
    logMemory("spawn", `Clone "${c.name}" deployed — ${c.role}, ${c.tone}.`);
    save();
    return c;
  }

  function replicate(cloneId) {
    const src = state.clones.find(c => c.id === cloneId);
    if (!src) return null;
    const copy = newClone({
      name: nextGenName(src.name),
      role: src.role, tone: src.tone, target: src.target,
      mindset: src.mindset, skills: src.skills,
      learningSource: src.learningSource,
      provider: src.provider,
      generation: (src.generation || 1) + 1,
      memory: src.memory
    });
    copy.memory.push(`Replicated from top performer "${src.name}" ($${src.stats.earnings} lifetime).`);
    state.clones.push(copy);
    logMemory("replicate", `"${src.name}" replicated → "${copy.name}" (gen ${copy.generation}).`);
    save();
    return copy;
  }

  function nextGenName(name) {
    const m = name.match(/^(.*?)\s+Mk\.(\d+)$/i);
    if (m) return `${m[1]} Mk.${parseInt(m[2], 10) + 1}`;
    return `${name} Mk.2`;
  }

  function deleteClone(cloneId) {
    const idx = state.clones.findIndex(c => c.id === cloneId);
    if (idx < 0) return;
    const [c] = state.clones.splice(idx, 1);
    state.tasks = state.tasks.filter(t => t.cloneId !== cloneId && t.partnerId !== cloneId);
    logMemory("delete", `Clone "${c.name}" decommissioned.`);
    save();
  }

  function topPerformer() {
    return state.clones.slice().sort((a, b) => b.stats.earnings - a.stats.earnings)[0] || null;
  }

  /* ---------------- tasks ---------------- */
  function addTask(input, result) {
    const t = {
      id: uid("tk"),
      cloneId: input.cloneId,
      partnerId: input.partnerId || null,
      type: input.type,
      topic: input.topic,
      outcome: input.outcome || "",
      objection: input.objection || "",
      niche: input.niche || "",
      urgency: input.urgency || "",
      repeatWeekly: !!input.repeatWeekly,
      lastRunAt: Date.now(),
      createdAt: Date.now(),
      output: result.text,
      engine: result.engine,
      cta: result.cta || "",
      rating: 0,
      learn: false,
      shared: false
    };
    state.tasks.push(t);
    save();
    return t;
  }

  function rateTask(taskId, rating) {
    const t = state.tasks.find(x => x.id === taskId);
    if (!t || t.rating === rating) return t;
    const first = t.rating === 0;
    t.rating = rating;
    const clone = state.clones.find(c => c.id === t.cloneId);
    if (clone && first) {
      const delta = E().recordOutcome(clone, t, rating);
      t.simEarnings = delta.earnings;
      t.simLeads = delta.leads;
      clone.ratingLog = clone.ratingLog || [];
      clone.ratingLog.push(rating);
      if (clone.ratingLog.length > 20) clone.ratingLog.shift();
      if (t.partnerId) {
        const partner = state.clones.find(c => c.id === t.partnerId);
        if (partner) {
          partner.stats.tasks += 1;
          partner.lastTaskAt = Date.now();
        }
      }
    }
    save();
    return t;
  }

  function setTaskFlag(taskId, flag, value) {
    const t = state.tasks.find(x => x.id === taskId);
    if (!t || t[flag] === value) return;
    t[flag] = value;
    const clone = state.clones.find(c => c.id === t.cloneId);
    if (flag === "learn" && value && clone) {
      const lesson = `${t.type} on "${t.topic}"${t.rating ? ` rated ${t.rating}/5` : ""}${t.cta ? ` — CTA: "${t.cta}"` : ""}`;
      if (!clone.memory.includes(lesson)) clone.memory.push(lesson);
      addVaultItem(clone.id, "lesson", `Lesson: ${t.type} — ${t.topic}`, lesson, t);
    }
    if (flag === "shared" && value) {
      const from = clone ? clone.name : "unknown";
      logMemory("share", `"${from}" shared ${t.type} logic ("${t.topic}") with GOD CORE — all clones can now draw on it.`);
      state.clones.forEach(c => {
        if (c.id !== t.cloneId) c.memory.push(`Shared from ${from}: ${t.type} on "${t.topic}"${t.cta ? ` — CTA: "${t.cta}"` : ""}`);
      });
    }
    save();
  }

  /* ---------------- vault ---------------- */
  function addVaultItem(cloneId, type, title, body, task) {
    const clone = state.clones.find(c => c.id === cloneId);
    if (!clone) return null;
    const item = {
      id: uid("vt"),
      type, title, body,
      taskType: task ? task.type : "",
      rating: task ? task.rating : 0,
      createdAt: Date.now()
    };
    clone.vault.push(item);
    save();
    return item;
  }

  function deleteVaultItem(cloneId, itemId) {
    const clone = state.clones.find(c => c.id === cloneId);
    if (!clone) return;
    clone.vault = clone.vault.filter(v => v.id !== itemId);
    save();
  }

  /* ---------------- broadcast queue ---------------- */
  function addQueueItem(input) {
    const q = {
      id: uid("bq"),
      cloneId: input.cloneId || null,
      title: input.title,
      text: input.text,
      dueAt: input.dueAt,
      status: "queued",
      createdAt: Date.now(),
      postedAt: null
    };
    state.queue.push(q);
    logMemory("queue", `Scheduled for X: "${q.title}" — ${new Date(q.dueAt).toLocaleString()}.`);
    save();
    return q;
  }

  function markPosted(queueId) {
    const q = state.queue.find(x => x.id === queueId);
    if (!q) return;
    q.status = "posted";
    q.postedAt = Date.now();
    logMemory("queue", `Posted to X: "${q.title}".`);
    save();
  }

  function deleteQueueItem(queueId) {
    state.queue = state.queue.filter(q => q.id !== queueId);
    save();
  }

  function dueQueue() {
    return state.queue.filter(q => q.status === "queued" && q.dueAt <= Date.now());
  }

  /* ---------------- system memory ---------------- */
  function logMemory(kind, text) {
    state.systemMemory.push({ id: uid("sm"), at: Date.now(), kind, text });
    if (state.systemMemory.length > 200) state.systemMemory.shift();
    /* Phase Alpha: every logged action also becomes a Bridge event */
    if (window.PRISM && PRISM.bridge) PRISM.bridge.onMemoryLog(kind, text);
    save();
  }

  /* ---------------- audit ---------------- */
  function runAudit() {
    const res = E().runAudit(state);
    if (res.ok) {
      state.lastAudit = Date.now();
      state.lastReport = res.report;
      state.pendingUpgrade = res.upgrade;
      logMemory("audit", `Weekly audit complete — ${res.report.tasksAudited} rated tasks analyzed.`);
      save();
    }
    return res;
  }

  function confirmUpgrade() {
    if (!state.pendingUpgrade) return null;
    const memo = E().applyUpgrade(state, state.pendingUpgrade);
    logMemory("upgrade", memo);
    state.pendingUpgrade = null;
    save();
    return memo;
  }

  function dismissUpgrade() {
    if (!state.pendingUpgrade) return;
    logMemory("audit", `Upgrade proposal dismissed: ${state.pendingUpgrade.headline}`);
    state.pendingUpgrade = null;
    save();
  }

  function auditDue() {
    if (!state.tasks.some(t => t.rating > 0)) return false;
    if (!state.lastAudit) return state.tasks.filter(t => t.rating > 0).length >= 3;
    return Date.now() - state.lastAudit > 7 * 86400000;
  }

  /* ---------------- weekly repeats ---------------- */
  async function runWeeklyRepeats() {
    const due = state.tasks.filter(t => t.repeatWeekly && Date.now() - t.lastRunAt > 7 * 86400000);
    const ran = [];
    for (const t of due) {
      const clone = state.clones.find(c => c.id === t.cloneId);
      if (!clone) continue;
      const result = await E().generate(clone, t, state.dna, state.settings);
      t.output = result.text;
      t.engine = result.engine;
      t.cta = result.cta || t.cta;
      t.lastRunAt = Date.now();
      t.rating = 0;
      addVaultItem(clone.id, PRISM.data.TASK_VAULT[t.type] || "content",
        `${t.type} — ${t.topic} (weekly re-run)`, result.text, t);
      clone.lastTaskAt = Date.now();
      ran.push(t);
    }
    if (ran.length) { logMemory("repeat", `${ran.length} weekly task(s) re-executed automatically.`); save(); }
    return ran;
  }

  /* ---------------- DNA / onboarding ---------------- */
  function trainDNA(dna) {
    state.dna = Object.assign({}, state.dna, dna);
    state.godBrainVersion += 1;
    state.clones.forEach(c => {
      if (c.learningSource === "Use GOD CORE DNA") {
        c.brainVersion = state.godBrainVersion;
        c.memory.push(`GOD CORE retrained (brain v${state.godBrainVersion}) — DNA refreshed.`);
        c.learnUntil = Date.now() + 30000;
      }
    });
    logMemory("dna", `GOD CORE trained — brain v${state.godBrainVersion}.`);
    save();
  }

  function completeOnboarding(dna, seedDemo) {
    state.dna = Object.assign({}, state.dna, dna);
    state.onboarded = true;
    logMemory("dna", "GOD CORE initialized with operator DNA — brain v1 online.");
    if (seedDemo) seedDemoClones();
    save();
  }

  /* ---------------- demo seed ---------------- */
  function seedDemoClones() {
    const specs = [
      { name: "APEX", role: "DM Closer", tone: "Direct", target: "$3k/month closed in DMs", skills: "Twitter DMs, Calendly", mindset: "Never chase. Qualify hard, close soft." },
      { name: "QUILL", role: "Copywriter", tone: "Entertainer", target: "5 viral posts/week", skills: "Twitter/X, hooks, threads", mindset: "Hook first. Every post earns the next line." },
      { name: "VULCAN", role: "Offer Generator", tone: "Persuasive", target: "$5k in new offers/month", skills: "Gumroad, pricing psychology", mindset: "Sell the outcome, stack the value, guarantee the risk away." }
    ];
    const topics = {
      "APEX": [["Close DM", "ghostwriting retainer"], ["Objection Handler", "coaching program"], ["DM Follow-Up", "audit call offer"]],
      "QUILL": [["Write Tweet", "personal branding"], ["Write Thread", "building a lead machine"], ["Write Caption", "client win story"]],
      "VULCAN": [["Build Offer", "notion template business"], ["Price & Package", "community membership"], ["Design Upsell", "course + coaching stack"]]
    };
    const r = E().rng(20260713);
    specs.forEach((spec, si) => {
      const c = addClone(spec);
      c.createdAt = Date.now() - 14 * 86400000;
      c.learnUntil = 0;
      (topics[spec.name] || []).forEach(([type, topic], ti) => {
        const daysAgo = 1 + Math.floor(r() * 6) + ti * 2;
        const when = Date.now() - daysAgo * 86400000;
        const fakeTask = { id: "seed_" + si + "_" + ti, type, topic, outcome: "", objection: "", niche: "", urgency: "" };
        const result = E().generateLocal(c, fakeTask, state.dna);
        const t = addTask({ cloneId: c.id, type, topic }, result);
        t.createdAt = when; t.lastRunAt = when;
        const rating = 3 + Math.floor(r() * 3);
        t.rating = rating;
        const delta = E().recordOutcome(c, t, rating, when);
        t.simEarnings = delta.earnings; t.simLeads = delta.leads;
        c.ratingLog.push(rating);
        addVaultItem(c.id, PRISM.data.TASK_VAULT[type] || "content", `${type} — ${topic}`, result.text, t);
      });
      c.lastTaskAt = Date.now() - 86400000;
    });
    logMemory("spawn", "Demo squadron deployed (APEX, QUILL, VULCAN) — delete them anytime.");
    save();
  }

  /* ---------------- settings / data mgmt ---------------- */
  function setSettings(patch) {
    state.settings = Object.assign({}, state.settings, patch);
    save();
  }

  function exportJSON() { return JSON.stringify(state, null, 2); }

  function importJSON(text) {
    const parsed = JSON.parse(text); /* throws on invalid */
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.clones)) {
      throw new Error("Not a PRISM-X export file.");
    }
    state = Object.assign(defaults(), parsed);
    save();
  }

  function reset() {
    state = defaults();
    save();
  }

  return {
    get state() { return state; },
    save, flush, suspendSaves, saveStats, uid,
    addClone, replicate, deleteClone, topPerformer,
    addTask, rateTask, setTaskFlag,
    addVaultItem, deleteVaultItem,
    addQueueItem, markPosted, deleteQueueItem, dueQueue,
    logMemory, runAudit, confirmUpgrade, dismissUpgrade, auditDue,
    runWeeklyRepeats, trainDNA, completeOnboarding, seedDemoClones,
    setSettings, exportJSON, importJSON, reset
  };
})();
