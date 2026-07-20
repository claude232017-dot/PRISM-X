/* PRISM-X — enterprise.js
 * PHASE ETA — ENTERPRISE OPERATING SYSTEM.
 *
 * One operating system for every business built inside PRISM-X:
 * organizations, CRM, revenue, projects (wired to Mission Control), teams,
 * automations, financial intelligence, executive dashboards and reports.
 *
 * Honesty line: the ledger is a real bookkeeping tool — entries are
 * owner-recorded. A labeled import can pull the Phase 2-4 SIMULATED
 * earnings in as clearly-tagged simulation entries; the two are never
 * silently mixed. Automations orchestrate real records across the CRM,
 * Mission Control, the Execution Layer and the ledger.
 */
window.PRISM = window.PRISM || {};

PRISM.enterprise = (function () {
  "use strict";
  const S = () => PRISM.store;
  const B = () => PRISM.bridge;
  const P = () => PRISM.providers;
  const K = () => PRISM.knowledge;
  const MS = () => PRISM.missions;
  const EV = () => PRISM.evolution;
  const D = () => PRISM.data;

  const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
  /* MODULE 5 — enterprise roles → Phase Alpha Permission Engine roles */
  const ROLE_MAP = {
    Owner: "Owner", Admin: "Administrator", Manager: "Administrator",
    Developer: "Partner", Closer: "Closer", Designer: "Freelancer",
    VA: "Freelancer", Affiliate: "Affiliate", Viewer: "Viewer"
  };
  const TEAM_ROLES = Object.keys(ROLE_MAP);

  /* MODULE 9 — business templates (deploy = real records across systems) */
  const BIZ_TEMPLATES = [
    { id: "ai-agency", icon: "🤖", name: "AI Agency", industry: "AI Services", cloneRole: "Sales Closer", msTemplate: "cold-outreach", kpis: ["3 discovery calls/wk", "$5k MRR", "2 case studies/mo"], playbook: "Land clients by showing, not telling: ship a 48-hour proof-of-work demo before any proposal. Price on outcomes, deliver via missions, systematize every win into the vault." },
    { id: "saas", icon: "🧪", name: "SaaS Startup", industry: "Software", cloneRole: "Growth Strategist", msTemplate: "product-launch", kpis: ["100 signups/mo", "5% free→paid", "<3% churn"], playbook: "One painful problem, one wedge feature, one channel. Ship weekly, talk to users daily, let missions run the launch loop." },
    { id: "content-brand", icon: "🎬", name: "Content Brand", industry: "Media", cloneRole: "Content Creator", msTemplate: "weekly-content", kpis: ["5 posts/day", "10%/wk follower growth", "1 offer/mo"], playbook: "Volume × consistency × one recognizable angle. The Weekly Content Engine mission is the heartbeat; shells amplify; every winner becomes a template." },
    { id: "affiliate", icon: "🔗", name: "Affiliate Business", industry: "Performance Marketing", cloneRole: "Funnel Architect", msTemplate: "competitor-analysis", kpis: ["3 funnels live", "$100/day", "2 traffic sources"], playbook: "Pick offers with recurring payouts, build comparison content that ranks, and let the funnel missions iterate angles weekly." },
    { id: "consulting", icon: "🧭", name: "Consulting Firm", industry: "Professional Services", cloneRole: "Sales Closer", msTemplate: "client-onboarding", kpis: ["2 retainers", "90% renewal", "1 productized offer"], playbook: "Sell the diagnosis, not hours. Productize the top-3 engagements, run delivery through projects + missions, capture every method in the vault." },
    { id: "ecommerce", icon: "🛒", name: "Ecommerce Store", industry: "Commerce", cloneRole: "Product Designer", msTemplate: "product-launch", kpis: ["3% conversion", "$30 AOV", "20% repeat rate"], playbook: "Test products with ghost launches before inventory. UGC-style content from the shells, launch missions per drop, reinvest by the numbers." }
  ];

  function ensure() {
    const st = S().state;
    st.enterprise = st.enterprise || { orgs: [], clients: [], projects: [], automations: [], finance: [], reports: [] };
    const en = st.enterprise;
    ["orgs", "clients", "projects", "automations", "finance", "reports"].forEach(k2 => { en[k2] = en[k2] || []; });
    return en;
  }
  function emit(text, meta) { B().emit("org", "🏛 " + text, meta || {}); }
  const money = (n) => "$" + Math.round(n).toLocaleString();

  /* ================================================================== *
   * MODULE 1 — organizations
   * ================================================================== */
  function orgs() { return ensure().orgs; }
  function org(id) { return orgs().find(o => o.id === id) || null; }
  function addOrg(input) {
    const en = ensure();
    const o = {
      id: S().uid("org"),
      name: (input.name || "New Org").trim().slice(0, 60),
      logo: input.logo || "🏛",
      industry: input.industry || "General",
      description: (input.description || "").slice(0, 300),
      status: input.status || "active",
      createdAt: Date.now(),
      templateId: input.templateId || null,
      kpis: input.kpis || [],
      team: [], /* {kind: human|worker|ghost|shell, refId, name, role} */
      integrationKeys: input.integrationKeys || [],
      missionIds: []
    };
    en.orgs.push(o);
    emit(`Organization created — ${o.logo} ${o.name} (${o.industry}).`, { priority: "medium" });
    S().save();
    return o;
  }
  function addTeamMember(orgId, kind, refId, role) {
    const o = org(orgId);
    if (!o) return false;
    const st = S().state;
    const pool = { human: st.executors, worker: st.clones, ghost: st.ghosts, shell: st.shells }[kind] || [];
    const ref = pool.find(x => x.id === refId);
    if (!ref || o.team.some(t => t.refId === refId)) return false;
    o.team.push({ kind, refId, name: ref.name, role: TEAM_ROLES.includes(role) ? role : "Viewer" });
    emit(`Team — ${ref.name} joined ${o.name} as ${role} (permissions inherit: ${ROLE_MAP[role] || "Viewer"}).`);
    S().save();
    return true;
  }
  function setTeamRole(orgId, refId, role) {
    const o = org(orgId);
    const t = o && o.team.find(x => x.refId === refId);
    if (!t) return false;
    t.role = role;
    S().save();
    return true;
  }

  /* ================================================================== *
   * MODULE 2 — CRM (workers reference this during missions)
   * ================================================================== */
  function clients() { return ensure().clients; }
  function client(id) { return clients().find(c => c.id === id) || null; }
  function addClient(input) {
    const en = ensure();
    const c = {
      id: S().uid("cli"),
      orgId: input.orgId || (orgs()[0] ? orgs()[0].id : null),
      name: (input.name || "Unnamed").trim().slice(0, 80),
      company: (input.company || "").slice(0, 80),
      email: (input.email || "").slice(0, 120),
      phone: (input.phone || "").slice(0, 40),
      stage: STAGES.includes(input.stage) ? input.stage : "lead",
      assignedWorkerId: input.assignedWorkerId || null,
      assignedHumanId: input.assignedHumanId || null,
      contracts: [], notes: [],
      timeline: [{ at: Date.now(), kind: "created", text: "Entered the pipeline as a lead." }],
      createdAt: Date.now()
    };
    en.clients.push(c);
    emit(`CRM — new ${c.stage}: ${c.name}${c.company ? " (" + c.company + ")" : ""}.`);
    S().save();
    return c;
  }
  function clientTimeline(id, kind, text) {
    const c = client(id);
    if (!c) return;
    c.timeline.push({ at: Date.now(), kind, text: String(text).slice(0, 200) });
    if (c.timeline.length > 50) c.timeline.shift();
    S().save();
  }
  function setStage(id, stage) {
    const c = client(id);
    if (!c || !STAGES.includes(stage)) return false;
    const prev = c.stage;
    c.stage = stage;
    clientTimeline(id, "stage", `Stage: ${prev} → ${stage}.`);
    emit(`CRM — ${c.name} moved to ${stage}.`, { priority: stage === "won" ? "medium" : "normal" });
    S().save();
    return true;
  }
  function clientRevenue(id) {
    return ensure().finance.filter(f => f.clientId === id && f.kind === "revenue").reduce((a, f) => a + f.amount, 0)
      - ensure().finance.filter(f => f.clientId === id && f.kind === "refund").reduce((a, f) => a + f.amount, 0);
  }
  /* the structured brief workers receive when a mission carries a client */
  function clientBrief(id) {
    const c = client(id);
    if (!c) return "";
    const lastNote = c.notes[c.notes.length - 1];
    return [
      `Client: ${c.name}${c.company ? " · " + c.company : ""} — pipeline stage: ${c.stage}.`,
      `Lifetime revenue: ${money(clientRevenue(id))}.`,
      c.assignedWorkerId ? `Assigned worker: ${(S().state.clones.find(x => x.id === c.assignedWorkerId) || {}).name || "—"}.` : "",
      lastNote ? `Latest note: ${lastNote.text}` : "",
      `Recent activity: ${c.timeline.slice(-2).map(t => t.text).join(" ")}`
    ].filter(Boolean).join(" ");
  }

  /* ================================================================== *
   * MODULE 3 — revenue center (real bookkeeping; sim imports labeled)
   * ================================================================== */
  const REV_CATS = ["product", "service", "affiliate", "one-time"];
  const EXP_CATS = ["tools", "providers", "acquisition", "other"];
  function addFinance(input) {
    const en = ensure();
    const f = {
      id: S().uid("fin"),
      at: input.at || Date.now(),
      orgId: input.orgId || (orgs()[0] ? orgs()[0].id : null),
      kind: ["revenue", "expense", "refund"].includes(input.kind) ? input.kind : "revenue",
      category: input.category || (input.kind === "expense" ? "other" : "one-time"),
      amount: Math.max(0, +input.amount || 0),
      recurring: !!input.recurring,
      simulated: !!input.simulated,
      clientId: input.clientId || null,
      missionId: input.missionId || null,
      note: (input.note || "").slice(0, 160)
    };
    en.finance.push(f);
    if (en.finance.length > 400) en.finance.shift();
    if (f.clientId) clientTimeline(f.clientId, "finance", `${f.kind} ${money(f.amount)}${f.note ? " — " + f.note : ""}${f.simulated ? " [SIM]" : ""}`);
    emit(`Ledger — ${f.kind} ${money(f.amount)} (${f.category}${f.recurring ? " · recurring" : ""}${f.simulated ? " · SIMULATED import" : ""}).`);
    S().save();
    return f;
  }
  function importSimEarnings(orgId) {
    const st = S().state;
    const en = ensure();
    if (en.finance.some(f => f.simulated && f.note === "ghost network import")) return null;
    const ghostRev = (st.products || []).reduce((a, p2) => a + (p2.revenue || 0), 0);
    const cloneRev = st.clones.reduce((a, c) => a + c.stats.earnings, 0);
    let n = 0;
    if (ghostRev > 0) { addFinance({ orgId, kind: "revenue", category: "product", amount: ghostRev, simulated: true, note: "ghost network import" }); n++; }
    if (cloneRev > 0) { addFinance({ orgId, kind: "revenue", category: "service", amount: cloneRev, simulated: true, note: "clone network import" }); n++; }
    if (n) emit(`Imported ${n} SIMULATED earning line(s) from the agent networks — clearly tagged, never mixed with real bookkeeping.`, { priority: "medium" });
    return n;
  }
  function financeStats(orgId) {
    const fs = ensure().finance.filter(f => !orgId || f.orgId === orgId);
    const sum = (pred) => fs.filter(pred).reduce((a, f) => a + f.amount, 0);
    const revenue = sum(f => f.kind === "revenue");
    const refunds = sum(f => f.kind === "refund");
    const expenses = sum(f => f.kind === "expense");
    const mrr = sum(f => f.kind === "revenue" && f.recurring);
    const week = Date.now() - 7 * 86400000, prevWeek = Date.now() - 14 * 86400000;
    const revThis = sum(f => f.kind === "revenue" && f.at > week);
    const revPrev = sum(f => f.kind === "revenue" && f.at > prevWeek && f.at <= week);
    return {
      revenue, refunds, expenses,
      profit: revenue - refunds - expenses,
      mrr, arr: mrr * 12,
      oneTime: sum(f => f.kind === "revenue" && !f.recurring),
      byCat: REV_CATS.map(c => [c, sum(f => f.kind === "revenue" && f.category === c)]),
      byExp: EXP_CATS.map(c => [c, sum(f => f.kind === "expense" && f.category === c)]),
      simulated: sum(f => f.simulated),
      growthPct: revPrev > 0 ? Math.round(((revThis - revPrev) / revPrev) * 100) : (revThis > 0 ? 100 : 0),
      entries: fs.length
    };
  }

  /* ================================================================== *
   * MODULE 4 — projects (wired straight into Mission Control)
   * ================================================================== */
  function projects() { return ensure().projects; }
  function project(id) { return projects().find(p2 => p2.id === id) || null; }
  function addProject(input) {
    const en = ensure();
    const p2 = {
      id: S().uid("prj"),
      orgId: input.orgId || (orgs()[0] ? orgs()[0].id : null),
      name: (input.name || "New Project").slice(0, 80),
      objectives: (input.objectives || "").slice(0, 300),
      deadline: input.deadline || Date.now() + 14 * 86400000,
      workerIds: input.workerIds || [],
      humanIds: input.humanIds || [],
      deliverables: (input.deliverables || ["Define scope", "Ship v1", "Review"]).map(d2 => ({ title: d2, done: false })),
      docIds: [], budget: +input.budget || 0, spent: 0,
      missionId: null, clientId: input.clientId || null,
      createdAt: Date.now()
    };
    en.projects.push(p2);
    emit(`Project opened — "${p2.name}"${p2.budget ? " · budget " + money(p2.budget) : ""}.`);
    S().save();
    return p2;
  }
  function connectMission(projectId, templateId) {
    const p2 = project(projectId);
    if (!p2 || !MS()) return null;
    const m = MS().plan({
      templateId: templateId || null,
      name: "Project — " + p2.name,
      objective: p2.objectives || p2.name,
      clientId: p2.clientId || null,
      deadline: p2.deadline
    });
    p2.missionId = m.id;
    const o = org(p2.orgId);
    if (o) o.missionIds.push(m.id);
    emit(`Project "${p2.name}" connected to Mission Control — "${m.name}" (${m.tasks.length} tasks).`, { priority: "medium" });
    S().save();
    return m;
  }
  function projectProgress(p2) {
    if (p2.missionId && MS()) {
      const m = MS().mission(p2.missionId);
      if (m) return MS().progress(m);
    }
    const done = p2.deliverables.filter(d2 => d2.done).length;
    return p2.deliverables.length ? Math.round((done / p2.deliverables.length) * 100) : 0;
  }

  /* ================================================================== *
   * MODULE 6 — business automation hub (real cross-system pipeline)
   * ================================================================== */
  function ensureAutomations(orgId) {
    const en = ensure();
    if (!en.automations.some(a => a.orgId === orgId)) {
      en.automations.push({
        id: S().uid("aut"),
        orgId, enabled: true,
        name: "Client Acquisition Pipeline",
        steps: ["Lead Capture", "CRM", "Mission", "Worker Assignment", "Proposal", "Follow-up", "Invoice (draft)", "Completion", "Review Request"],
        runs: 0, lastRun: null
      });
    }
  }
  function automations(orgId) { ensure(); if (orgId) ensureAutomations(orgId); return ensure().automations.filter(a => !orgId || a.orgId === orgId); }
  async function runAutomation(autId, clientId) {
    const a = ensure().automations.find(x => x.id === autId);
    if (!a || !a.enabled) return { ok: false, reason: "automation not found or disabled" };
    const c = client(clientId);
    if (!c) return { ok: false, reason: "pick a CRM client first" };
    emit(`Automation "${a.name}" started for ${c.name} — orchestrating CRM → Mission → Ledger.`, { priority: "medium" });
    clientTimeline(c.id, "automation", `"${a.name}" started.`);
    if (c.stage === "lead") setStage(c.id, "qualified");
    /* mission with the client brief riding into every task */
    const m = MS().plan({ templateId: "cold-outreach", name: `${a.name} — ${c.name}`, objective: `Close ${c.name}${c.company ? " (" + c.company + ")" : ""}`, clientId: c.id });
    const o = org(a.orgId);
    if (o) o.missionIds.push(m.id);
    const res = await MS().runMission(m.id);
    clientTimeline(c.id, "mission", `Mission "${m.name}" ${res.ok ? "completed — proposal + follow-up assets ready" : "halted (" + m.status + ")"}.`);
    if (res.ok) {
      setStage(c.id, "proposal");
      const inv = addFinance({ orgId: a.orgId, kind: "revenue", category: "service", amount: 0, clientId: c.id, note: `DRAFT invoice — ${a.name} (set the amount when the deal closes)` });
      clientTimeline(c.id, "invoice", "Draft invoice created in the ledger (amount pending close).");
      clientTimeline(c.id, "review", "Review request queued for after delivery.");
      a.runs += 1; a.lastRun = Date.now();
      emit(`Automation "${a.name}" completed for ${c.name} — mission done, stage → proposal, draft invoice logged.`, { priority: "medium" });
      S().save();
      return { ok: true, mission: m, invoice: inv };
    }
    a.runs += 1; a.lastRun = Date.now();
    S().save();
    return { ok: false, reason: "mission " + m.status, mission: m };
  }

  /* ================================================================== *
   * MODULE 7 — financial intelligence
   * ================================================================== */
  function intelligence(orgId) {
    const fs = financeStats(orgId);
    const cs = clients().filter(c => !orgId || c.orgId === orgId);
    const byClient = cs.map(c => ({ name: c.name, stage: c.stage, revenue: clientRevenue(c.id) })).sort((a, b2) => b2.revenue - a.revenue);
    const won = cs.filter(c => c.stage === "won");
    const clv = won.length ? Math.round(won.reduce((a, c) => a + clientRevenue(c.id), 0) / won.length) : 0;
    const acqSpend = ensure().finance.filter(f => f.kind === "expense" && f.category === "acquisition" && (!orgId || f.orgId === orgId)).reduce((a, f) => a + f.amount, 0);
    const cac = won.length ? Math.round(acqSpend / won.length) : acqSpend;
    const provCost = P() ? +(P().analyticsOf("claude").costEst + P().analyticsOf("local").costEst).toFixed(4) : 0;
    const missionProfit = (MS() ? MS().stats().totalCost : 0);
    return {
      topClients: byClient.slice(0, 5),
      byCat: fs.byCat.slice().sort((a, b2) => b2[1] - a[1]),
      clv, cac,
      growthPct: fs.growthPct,
      missionCost: missionProfit,
      toolCosts: fs.byExp.find(x => x[0] === "tools")[1],
      providerCosts: provCost,
      automationCosts: 0
    };
  }

  /* ================================================================== *
   * MODULE 8 — executive dashboard
   * ================================================================== */
  function healthScore() {
    const fs = financeStats(null);
    const msS = MS() ? MS().stats() : { successRate: null, active: 0 };
    const st = S().state;
    const week = Date.now() - 7 * 86400000;
    const util = st.clones.length ? st.clones.filter(c => c.lastTaskAt && c.lastTaskAt > week).length / st.clones.length : 0;
    const cs = clients();
    const wonRatio = cs.length ? cs.filter(c => c.stage === "won").length / cs.length : 0;
    const evScore = EV() ? EV().systemScore() : 60;
    let score = 0;
    score += fs.profit > 0 ? 25 : fs.revenue > 0 ? 12 : 5;
    score += Math.min(15, msS.active * 5 + (msS.successRate || 0) / 10);
    score += Math.round(util * 20);
    score += Math.round(wonRatio * 20);
    score += Math.round(evScore / 5);
    return Math.min(100, score);
  }
  function executive() {
    const fs = financeStats(null);
    const msS = MS() ? MS().stats() : {};
    const st = S().state;
    const week = Date.now() - 7 * 86400000;
    const util = st.clones.length ? Math.round(st.clones.filter(c => c.lastTaskAt && c.lastTaskAt > week).length / st.clones.length * 100) : 0;
    const cs = clients();
    const atRisk = cs.filter(c => !["won", "lost"].includes(c.stage) && (!c.timeline.length || Date.now() - c.timeline[c.timeline.length - 1].at > 7 * 86400000));
    const risks = [];
    (MS() ? MS().missions() : []).forEach(m => { if (MS().health(m) === "delayed") risks.push(`Mission delayed — "${m.name}"`); });
    atRisk.forEach(c => risks.push(`Client cooling off — ${c.name} (no activity 7d)`));
    if (EV() && EV().stats().pending) risks.push(`${EV().stats().pending} improvement(s) awaiting your approval`);
    const wins = [];
    cs.filter(c => c.stage === "won").slice(-3).forEach(c => wins.push(`Won ${c.name} — ${money(clientRevenue(c.id))} lifetime`));
    (MS() ? MS().missions() : []).filter(m => m.status === "completed").slice(-3).forEach(m => wins.push(`Mission completed — "${m.name}" (${m.successScore}/100)`));
    if (EV()) EV().suggestions().filter(s2 => s2.state === "accepted").slice(-2).forEach(s2 => wins.push(`Improvement accepted — ${s2.title}`));
    return {
      revenue: fs.revenue, profit: fs.profit, mrr: fs.mrr, growthPct: fs.growthPct, simulated: fs.simulated,
      activeMissions: msS.active || 0,
      workerUtilization: util,
      providerCosts: P() ? +(P().analyticsOf("claude").costEst + P().analyticsOf("local").costEst).toFixed(4) : 0,
      clientHealth: { total: cs.length, won: cs.filter(c => c.stage === "won").length, atRisk: atRisk.length },
      health: healthScore(),
      risks: risks.slice(0, 6),
      wins: wins.slice(0, 6)
    };
  }

  /* ================================================================== *
   * MODULE 9 — deploy a business template (real records everywhere)
   * ================================================================== */
  function deployTemplate(tplId, orgName) {
    const tpl = BIZ_TEMPLATES.find(t => t.id === tplId);
    if (!tpl) return null;
    const st = S().state;
    const o = addOrg({
      name: orgName || tpl.name,
      logo: tpl.icon, industry: tpl.industry,
      description: `Deployed from the ${tpl.name} blueprint.`,
      templateId: tpl.id, kpis: tpl.kpis.slice()
    });
    /* a real worker fitted to the business */
    let cloneName = (o.name.split(/\s+/)[0] || "ORG").toUpperCase().slice(0, 10) + "-PRIME";
    if (st.clones.some(c => c.name === cloneName)) cloneName += "-" + (st.clones.length + 1);
    const c = S().addClone({ name: cloneName, role: tpl.cloneRole, tone: "Direct", target: tpl.kpis[0] || "", mindset: "", skills: tpl.industry, learningSource: "Use GOD CORE DNA", provider: "auto" });
    addTeamMember(o.id, "worker", c.id, "Manager");
    /* knowledge base seed (real playbook content) */
    if (K()) {
      const d2 = K().addDoc({ title: `${tpl.name} playbook — ${o.name}`, body: tpl.playbook + "\nKPIs: " + tpl.kpis.join(" · "), type: "playbook", category: "Business", layer: "business", tags: [tpl.id, "org"], source: "manual", owner: o.name });
      /* project workspace can pin it later */
      o.playbookDocId = d2.id;
    }
    /* starter workflow in the Phase Alpha registry */
    B().addWorkflow({ name: `${o.name} — weekly ops review`, description: "Review KPIs, ledger and mission health for " + o.name, workerId: c.id, trigger: "scheduled", steps: ["Pull executive dashboard", "Compare KPIs vs actuals", "File improvement suggestions"], expectedResult: "Weekly ops summary in the vault" });
    ensureAutomations(o.id);
    emit(`Business deployed — ${tpl.icon} ${o.name}: CRM ready, worker ${c.name} forged, playbook stored, ops workflow registered, automation attached, KPIs set (${tpl.kpis.join(" · ")}).`, { priority: "high" });
    S().save();
    return { org: o, clone: c };
  }

  /* ================================================================== *
   * MODULE 10 — executive reports
   * ================================================================== */
  const PERIODS = { daily: 1, weekly: 7, monthly: 30, quarterly: 90 };
  function generateReport(period) {
    period = PERIODS[period] ? period : "weekly";
    const days = PERIODS[period];
    const since = Date.now() - days * 86400000;
    const fs = ensure().finance;
    const sum = (pred) => fs.filter(pred).reduce((a, f) => a + f.amount, 0);
    const rev = sum(f => f.kind === "revenue" && f.at > since);
    const revPrev = sum(f => f.kind === "revenue" && f.at > since - days * 86400000 && f.at <= since);
    const exp = sum(f => f.kind === "expense" && f.at > since);
    const msS = MS() ? MS().stats() : {};
    const ex = executive();
    const cards = EV() ? EV().stats().cards.slice().sort((a, b2) => b2.composite - a.composite) : [];
    const recs = EV() ? EV().suggestions().filter(s2 => s2.state === "pending").slice(0, 3).map(s2 => s2.title) : [];
    const priorities = [];
    (MS() ? MS().missions() : []).filter(m => m.status === "active").forEach(m => {
      const bn = MS().bottleneck(m);
      if (bn) priorities.push(`"${m.name}": ${bn}`);
    });
    if (S().dueQueue().length) priorities.push(`${S().dueQueue().length} post(s) due in the Broadcast Queue`);
    clients().filter(c => c.stage === "proposal" || c.stage === "negotiation").forEach(c => priorities.push(`Close ${c.name} (${c.stage})`));
    const text = [
      `EXECUTIVE REPORT — ${period.toUpperCase()} · ${new Date().toLocaleString()}`,
      ``,
      `── REVENUE ──`,
      `Period revenue: ${money(rev)} (${revPrev ? (rev >= revPrev ? "+" : "") + Math.round(((rev - revPrev) / revPrev) * 100) + "% vs prior period" : "no prior-period baseline"})`,
      `Period expenses: ${money(exp)} · MRR ${money(financeStats(null).mrr)} · lifetime profit ${money(ex.profit)}`,
      ex.simulated ? `⚠ ${money(ex.simulated)} of lifetime revenue is tagged SIMULATED (agent-network import) — excluded from bookkeeping truth.` : `All ledger entries are owner-recorded (no simulated lines).`,
      ``,
      `── GROWTH ──`,
      `Business health ${ex.health}/100 · worker utilization ${ex.workerUtilization}% · pipeline ${ex.clientHealth.total} client(s), ${ex.clientHealth.won} won, ${ex.clientHealth.atRisk} at risk`,
      ``,
      `── MISSIONS ──`,
      `${msS.completed || 0}/${msS.total || 0} completed · ${msS.successRate == null ? "—" : msS.successRate + "%"} success · ${msS.outputs || 0} artifacts · est provider cost $${ex.providerCosts}`,
      ``,
      `── WORKER PERFORMANCE ──`,
      ...(cards.slice(0, 4).map(c => `${c.name}: ${c.composite}/100 (${c.tasks} task(s))`)),
      ``,
      `── RECOMMENDATIONS (Evolution Engine, approval-gated) ──`,
      ...(recs.length ? recs.map(r => `• ${r}`) : ["• Nothing pending — run a Performance Analysis."]),
      ``,
      `── UPCOMING PRIORITIES ──`,
      ...(priorities.length ? priorities.slice(0, 6).map(p2 => `• ${p2}`) : ["• Clear runway — plan the next mission."])
    ].join("\n");
    const rep = { id: S().uid("rep"), period, at: Date.now(), text };
    ensure().reports.push(rep);
    if (ensure().reports.length > 24) ensure().reports.shift();
    emit(`Executive report generated — ${period}.`, { priority: "medium" });
    S().save();
    return rep;
  }
  function reports() { return ensure().reports.slice().reverse(); }

  function boot() {
    ensure();
    const st = S().state;
    if (!st.enterpriseReady && st.onboarded) {
      st.enterpriseReady = true;
      emit("Enterprise Operating System online — organizations, CRM, ledger, projects, automations and executive reporting are live.", { priority: "medium" });
      S().save();
    }
  }

  return {
    STAGES, TEAM_ROLES, ROLE_MAP, BIZ_TEMPLATES, REV_CATS, EXP_CATS, PERIODS,
    ensure, orgs, org, addOrg, addTeamMember, setTeamRole,
    clients, client, addClient, setStage, clientTimeline, clientRevenue, clientBrief,
    addFinance, importSimEarnings, financeStats,
    projects, project, addProject, connectMission, projectProgress,
    automations, runAutomation,
    intelligence, healthScore, executive,
    deployTemplate, generateReport, reports, boot, money
  };
})();
