/* PRISM-X — matrix.js · PHASE 4: THE MATRIX MERGE
 * The human executor bridge. Connects clones, ghosts and shells to a hybrid
 * workforce: briefs are generated from REAL agent assets (DM flows, sales
 * pages, shell posts) and exportable as packets you can genuinely send to a
 * freelancer. Task delivery, close-rates and payouts are a labeled simulation
 * (no backend = no logins, Stripe/PayPal rails, or B2B data feeds) — but the
 * ledger math, pay-share splits, reinvestment pool and SuperFunnel wiring are
 * fully functional accounting on the shared sim clock.
 */
window.PRISM = window.PRISM || {};

PRISM.matrix = (function () {
  "use strict";
  const E = () => PRISM.engine, S = () => PRISM.store, G = () => PRISM.ghosts, SH = () => PRISM.shells;
  const DAY = 86400000;
  function now() { return Date.now() + (S().state.ghostSimOffset || 0); }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const money = n => "$" + Math.round(n).toLocaleString();

  /* ------------------------------------------------------------------ *
   * Executor roles — what they take, from which agent class
   * ------------------------------------------------------------------ */
  const ROLES = {
    "DM Closer":         { icon: "◈", feeds: "leads from Shell DM flows and Ghost products", defaultShare: 30 },
    "Cold Email Closer": { icon: "✉", feeds: "auto-fed lead lists (B2B feed simulated)", defaultShare: 30 },
    "Copy Editor":       { icon: "✎", feeds: "Ghost sales pages needing a human pass", defaultShare: 10 },
    "Designer":          { icon: "▦", feeds: "Shell posts to turn into carousels / B-roll", defaultShare: 12 },
    "VA":                { icon: "⌗", feeds: "product uploads, affiliate setup, ops", defaultShare: 8 }
  };
  const PERMISSIONS = ["basic", "trusted", "partner"];
  const PERM_BONUS = { basic: 0, trusted: 8, partner: 14 };

  const LOOP_KINDS = [
    { id: "dm",        label: "Send DM replies to this closer",            roles: ["DM Closer"] },
    { id: "email",     label: "Close captured leads via cold email",       roles: ["Cold Email Closer"] },
    { id: "visuals",   label: "Send content to this editor for visuals",   roles: ["Designer"] },
    { id: "copy",      label: "Outsource launch copy tweaks",              roles: ["Copy Editor"] },
    { id: "affiliate", label: "Assign affiliate growth",                   roles: ["VA", "Cold Email Closer"] }
  ];

  /* ------------------------------------------------------------------ *
   * Executors
   * ------------------------------------------------------------------ */
  function onboard(input) {
    const st = S().state;
    const ex = {
      id: S().uid("ex"),
      name: (input.name || "EXECUTOR").trim(),
      role: input.role || "DM Closer",
      contact: (input.contact || "").trim(),
      permission: PERMISSIONS.includes(input.permission) ? input.permission : "basic",
      payShare: Math.min(70, Math.max(1, parseInt(input.payShare, 10) || ROLES[input.role || "DM Closer"].defaultShare)),
      score: 55 + PERM_BONUS[input.permission || "basic"],
      tasksDone: 0,
      earnings: 0,
      streak: 0,
      active: true,
      createdAt: now(),
      memory: [`Onboarded as ${input.role} · ${input.permission || "basic"} access · ${input.payShare || ROLES[input.role || "DM Closer"].defaultShare}% PayShare.`]
    };
    st.executors.push(ex);
    S().logMemory("matrix", `👤 Executor "${ex.name}" onboarded — ${ex.role}, ${ex.payShare}% PayShare (${ex.permission}).`);
    S().save();
    return ex;
  }

  function removeExecutor(id) {
    const st = S().state;
    const ex = st.executors.find(x => x.id === id);
    st.executors = st.executors.filter(x => x.id !== id);
    st.mtasks = st.mtasks.filter(t => t.executorId !== id);
    st.superFunnels.forEach(f => { if (f.executorId === id) f.active = false; });
    st.shells.forEach(s => { if (s.humanLoop && s.humanLoop.executorId === id) s.humanLoop = null; });
    st.ghosts.forEach(g => { if (g.humanLoop && g.humanLoop.executorId === id) g.humanLoop = null; });
    if (ex) S().logMemory("matrix", `👤 Executor "${ex.name}" released from the Matrix.`);
    S().save();
  }

  function bestExecutor(role) {
    return S().state.executors
      .filter(x => x.active && x.role === role)
      .sort((a, b) => b.score - a.score)[0] || null;
  }

  /* ------------------------------------------------------------------ *
   * Brief generation — built from REAL agent assets
   * ------------------------------------------------------------------ */
  function agentLabel(sourceType, sourceId) {
    const st = S().state;
    if (sourceType === "shell") { const s = st.shells.find(x => x.id === sourceId); return s ? `Shell ${s.name}` : "a Shell"; }
    if (sourceType === "ghost") { const g = st.ghosts.find(x => x.id === sourceId); return g ? `Ghost ${g.name}` : "a Ghost"; }
    if (sourceType === "product") { const p = st.products.find(x => x.id === sourceId); return p ? `"${p.name}"` : "a product"; }
    if (sourceType === "clone") { const c = st.clones.find(x => x.id === sourceId); return c ? `Clone ${c.name}` : "a Clone"; }
    return "GOD CORE";
  }

  function buildBrief(ex, source) {
    const st = S().state;
    const r = E().rng(E().hashStr(ex.id + ":" + (source.id || "core") + ":" + now()));
    const deadline = now() + 2 * DAY;
    const head = [
      `═══ PRISM-X TASK BRIEF ═══`,
      `Executor: ${ex.name} (${ex.role} · ${ex.permission} access)`,
      `Pay: ${["DM Closer", "Cold Email Closer"].includes(ex.role) ? ex.payShare + "% per closed sale (PayShare)" : "flat rate on approval + " + ex.payShare + "% performance bonus"}`,
      `Deadline: ${new Date(deadline).toLocaleString()} (48h)`,
      st.dna && st.dna.decision ? `Operating laws (GOD CORE Decision Framework): ${st.dna.decision}` : "",
      ``
    ].filter(x => x !== "").join("\n");

    let title = "", body = "", revenueTask = false;

    if (ex.role === "DM Closer") {
      const shell = source.shell || st.shells[0];
      const product = source.product || st.products.filter(p => p.status !== "retired").slice(-1)[0];
      const leads = 6 + Math.floor(r() * 12);
      const dmFlow = product && product.assets ? product.assets.dmFlow : (shell && shell.posts.slice(-1)[0] ? shell.posts.slice(-1)[0].cta : "Use the standard 3-touch flow.");
      title = `Close ${leads} inbound leads${shell ? " from " + shell.name : ""}`;
      revenueTask = true;
      body = [
        `MISSION: You've been assigned ${leads} inbound leads${shell ? ` from Shell ${shell.name} (${shell.niche})` : ""}.`,
        `Your task: close via DM. You earn ${ex.payShare}% per sale.`,
        product ? `OFFER: "${product.name}" at ${product.price > 0 ? "$" + product.price : "affiliate terms"} — angle: ${product.angle}.` : "",
        ``, `── SCRIPT (from the agent's vault) ──`, dmFlow,
        ``, `── RULES ──`,
        `• One question per message. Mirror their words before every ask.`,
        `• Log every objection you hear — GOD CORE trains on them.`,
        `• No discounts without operator approval.`
      ].filter(x => x !== "").join("\n");
    } else if (ex.role === "Cold Email Closer") {
      const product = source.product || st.products.slice(-1)[0];
      const rows = 40 + Math.floor(r() * 80);
      title = `Work a ${rows}-contact cold list${product ? ` for "${product.name}"` : ""}`;
      revenueTask = true;
      body = [
        `MISSION: ${rows} B2B contacts (list attached in your channel — feed simulated here).`,
        `You earn ${ex.payShare}% per closed sale.`,
        product && product.assets ? `── EMAIL BASE COPY ──\n${(product.assets.salesPage || "").slice(0, 500)}` : "",
        ``, `── SEQUENCE ──`, `Touch 1: value + proof. Touch 2 (+2d): case study. Touch 3 (+4d): direct offer with deadline.`
      ].filter(x => x !== "").join("\n");
    } else if (ex.role === "Copy Editor") {
      const product = source.product || st.products.slice(-1)[0];
      title = `Edit sales page: ${product ? product.name : "latest ghost product"}`;
      body = [
        `MISSION: Human pass on a ghost-written sales page. Tighten hooks, kill AI-isms, keep the angle (${product ? product.angle : "as briefed"}).`,
        ``, `── DRAFT ──`, product && product.assets ? product.assets.salesPage : "(attached)",
        ``, `DELIVERABLE: edited page + one-line changelog of what you fixed.`
      ].join("\n");
    } else if (ex.role === "Designer") {
      const shell = source.shell || st.shells[0];
      const post = shell && shell.posts.slice(-1)[0];
      title = `Design pack for ${shell ? shell.name : "shell"} (${post ? post.format : "posts"})`;
      body = [
        `MISSION: Turn the post below into a carousel + 3 B-roll cuts. Faceless — no people, no watermarks.`,
        shell ? `BRAND: ${shell.niche} · persona ${shell.persona} · platforms ${shell.platforms.join("/")}.` : "",
        ``, `── SOURCE POST ──`, post ? post.body : "(latest drop)",
        post && post.broll ? `\n── B-ROLL DIRECTION ──\n• ${post.broll.join("\n• ")}` : "",
        ``, `DELIVERABLE: 5-slide carousel (1080×1350) + 3 vertical clips (9:16).`
      ].filter(x => x !== "").join("\n");
    } else { /* VA */
      const product = source.product || st.products.slice(-1)[0];
      title = `Ops: upload ${product ? `"${product.name}"` : "latest product"} + affiliate setup`;
      body = [
        `MISSION: Upload the product to ${product ? product.platform : "the platform"}, set pricing, connect the affiliate program, verify checkout.`,
        product ? `LISTING COPY:\n${(product.assets && product.assets.salesPage || "").slice(0, 400)}` : "",
        ``, `CHECKLIST: listing live → test purchase → affiliate link generated → links delivered to Shell bios.`
      ].filter(x => x !== "").join("\n");
    }

    return { title, brief: head + body, deadline, revenueTask };
  }

  /* ------------------------------------------------------------------ *
   * Task lifecycle: assign → (auto)deliver → score
   * ------------------------------------------------------------------ */
  function assignTask(executorId, source) {
    const st = S().state;
    const ex = st.executors.find(x => x.id === executorId);
    if (!ex) return null;
    const b = buildBrief(ex, source || {});
    const t = {
      id: S().uid("mt"),
      executorId: ex.id,
      sourceType: source && source.type || "core",
      sourceId: source && source.id || null,
      title: b.title,
      brief: b.brief,
      deadline: b.deadline,
      revenueTask: b.revenueTask,
      status: "assigned",
      createdAt: now(),
      deliveredAt: null,
      rating: 0,
      revenue: 0,
      payout: 0
    };
    st.mtasks.push(t);
    ex.memory.push(`Assigned: ${t.title}.`);
    S().logMemory("matrix", `🤖→👤 ${agentLabel(t.sourceType, t.sourceId)} assigned "${t.title}" to ${ex.name}.`);
    S().save();
    return t;
  }

  /* Simulated delivery quality biased by executor score. */
  function deliver(t) {
    const st = S().state;
    const ex = st.executors.find(x => x.id === t.executorId);
    t.status = "delivered";
    t.deliveredAt = now();
    if (ex && t.revenueTask) {
      const r = E().rng(E().hashStr(t.id + ":rev"));
      const closes = Math.max(0, Math.round((ex.score / 25) * (0.4 + r() * 1.2)));
      const product = st.products.find(p => p.id === t.sourceId) || st.products.slice(-1)[0];
      const unit = product && product.price > 0 ? product.price : 40 + Math.floor(r() * 60);
      t.revenue = closes * unit;
      if (t.revenue > 0) split(t.revenue, agentLabel(t.sourceType, t.sourceId), ex, `task "${t.title}"`);
      t.payout = Math.round(t.revenue * ex.payShare / 100);
    }
    return t;
  }

  function scoreTask(taskId, rating) {
    const st = S().state;
    const t = st.mtasks.find(x => x.id === taskId);
    if (!t || t.status === "scored") return t;
    const ex = st.executors.find(x => x.id === t.executorId);
    t.rating = rating;
    t.status = "scored";
    if (ex) {
      ex.score = Math.round(Math.min(99, Math.max(20, ex.score * 0.8 + rating * 20 * 0.2)));
      ex.tasksDone += 1;
      ex.streak = rating >= 4 ? ex.streak + 1 : 0;
      ex.memory.push(`"${t.title}" scored ${rating}/5 → performance ${ex.score}.`);
      /* quality feedback loops into the agents */
      if (rating >= 4) {
        if (ex.role === "Designer" && t.sourceType === "shell") {
          const s = st.shells.find(x => x.id === t.sourceId);
          if (s) { s.quality = Math.min(1.4, s.quality + 0.05); s.memory.push(`Visual pack from ${ex.name} boosted content quality.`); }
        }
        if (ex.role === "Copy Editor" && (t.sourceType === "product" || t.sourceType === "ghost")) {
          const g = st.ghosts.find(x => x.id === t.sourceId) || (st.products.find(p => p.id === t.sourceId) && st.ghosts.find(x => x.id === st.products.find(p => p.id === t.sourceId).ghostId));
          if (g) { g.copyBoost = (g.copyBoost || 0) + 1; g.memory.push(`Human copy pass by ${ex.name} — next launch inherits the edits.`); }
        }
      }
    }
    S().save();
    return t;
  }

  /* ------------------------------------------------------------------ *
   * Income redistribution — every dollar tagged and split
   * ------------------------------------------------------------------ */
  function split(gross, sourceLabel, ex, desc) {
    const st = S().state;
    const humanCut = ex ? Math.round(gross * ex.payShare / 100) : 0;
    const rest = gross - humanCut;
    const reinvest = Math.round(rest * (st.matrixConfig.reinvestPct || 50) / 100);
    const operator = rest - reinvest;
    if (ex) { ex.earnings += humanCut; }
    st.reinvestPool += reinvest;
    st.vaultBalance += operator;
    st.ledger.push({
      id: S().uid("lg"),
      at: now(),
      source: sourceLabel,
      desc: desc || "",
      executorId: ex ? ex.id : null,
      executorName: ex ? ex.name : null,
      gross, toHuman: humanCut, toReinvest: reinvest, toOperator: operator
    });
    if (st.ledger.length > 200) st.ledger.shift();
    return { humanCut, reinvest, operator };
  }

  function weeklyReportLines() {
    const st = S().state;
    const since = now() - 7 * DAY;
    const bySource = {};
    st.ledger.filter(l => l.at >= since).forEach(l => {
      const b = bySource[l.source] = bySource[l.source] || { gross: 0, human: 0, reinvest: 0, operator: 0, who: l.executorName };
      b.gross += l.gross; b.human += l.toHuman; b.reinvest += l.toReinvest; b.operator += l.toOperator;
      if (l.executorName) b.who = l.executorName;
    });
    return Object.entries(bySource).map(([src, b]) =>
      `${src} earned ${money(b.gross)} this week. ${money(b.human)} sent to ${b.who || "executors"}, ${money(b.reinvest)} reinvested, ${money(b.operator)} deposited to main vault.`);
  }

  const GHOST_COST = 100;
  function reinvestIntoGhost() {
    const st = S().state;
    if (st.reinvestPool < GHOST_COST) return null;
    st.reinvestPool -= GHOST_COST;
    const r = E().rng(E().hashStr("reinvest:" + now()));
    const g = G().createGhost({
      name: "REINVEST-" + (st.ghosts.length + 1),
      template: "custom",
      focus: "Reinvestment spawn",
      niche: "random",
      targetIncome: 100,
      productType: pick(r, G().PRODUCT_TYPES),
      platform: "Gumroad",
      tone: "Persuasive"
    });
    S().logMemory("matrix", `📈 Reinvest pool spent ${money(GHOST_COST)} → new Product Ghost ${g.name} spawned.`);
    S().save();
    return g;
  }

  function withdraw() {
    const st = S().state;
    const amt = st.reinvestPool;
    st.vaultBalance += amt;
    st.reinvestPool = 0;
    if (amt > 0) S().logMemory("matrix", `💰 ${money(amt)} withdrawn from reinvest pool to main vault.`);
    S().save();
    return amt;
  }

  /* ------------------------------------------------------------------ *
   * SuperFunnels: Shell (audience) → Ghost product (offer) → Closer (human)
   * ------------------------------------------------------------------ */
  function createSuperFunnel(shellId, productId, executorId) {
    const st = S().state;
    const shell = st.shells.find(s => s.id === shellId);
    const product = st.products.find(p => p.id === productId);
    const ex = st.executors.find(x => x.id === executorId);
    if (!shell || !product || !ex) return null;
    const f = {
      id: S().uid("sf"),
      name: `${shell.name} × ${product.name.split(" ").slice(0, 3).join(" ")} × ${ex.name}`,
      shellId, productId, executorId,
      active: true,
      createdAt: now(),
      lastRunAt: null,
      stats: { days: 0, leads: 0, closes: 0, gross: 0 }
    };
    st.superFunnels.push(f);
    shell.memory.push(`Wired into SuperFunnel: audience → "${product.name}" → closed by ${ex.name}.`);
    ex.memory.push(`Assigned to SuperFunnel "${f.name}".`);
    S().logMemory("matrix", `🔗 SuperFunnel forged: ${shell.name} (audience) → "${product.name}" (offer) → ${ex.name} (closer).`);
    S().save();
    return f;
  }

  /* One sim day of a funnel or standing human loop. */
  function runFunnelDay(f, dayIdx) {
    const st = S().state;
    const shell = st.shells.find(s => s.id === f.shellId);
    const product = st.products.find(p => p.id === f.productId);
    const ex = st.executors.find(x => x.id === f.executorId);
    if (!shell || !product || !ex || !ex.active) return null;
    const r = E().rng(E().hashStr(f.id + ":day:" + dayIdx));
    const lastDay = shell.daily[shell.daily.length - 1];
    const leads = Math.max(1, Math.round(((lastDay ? lastDay.clicks : 4) * (0.5 + r() * 0.7))));
    const closeRate = (ex.score / 100) * (0.08 + r() * 0.10);
    const closes = Math.round(leads * closeRate);
    const unit = product.price > 0 ? product.price : 35;
    const gross = closes * unit;
    f.stats.days += 1; f.stats.leads += leads; f.stats.closes += closes; f.stats.gross += gross;
    if (gross > 0) {
      const cut = split(gross, `SuperFunnel "${f.name}"`, ex, `${closes} close(s) on "${product.name}"`);
      return `🔗 SuperFunnel ${shell.name}→${ex.name}: ${closes} sale(s), ${money(gross)} gross (${money(cut.humanCut)} to ${ex.name}).`;
    }
    return null;
  }

  function runLoopDay(owner, ownerType, dayIdx) {
    const st = S().state;
    const loop = owner.humanLoop;
    if (!loop) return null;
    const ex = st.executors.find(x => x.id === loop.executorId);
    if (!ex || !ex.active) return null;
    const r = E().rng(E().hashStr(owner.id + ":loop:" + dayIdx));
    let gross = 0, label = "";
    if (ownerType === "shell") {
      const lastDay = owner.daily[owner.daily.length - 1];
      const leads = Math.round((lastDay ? lastDay.clicks : 3) * (0.3 + r() * 0.5));
      const closes = Math.round(leads * (ex.score / 100) * (0.06 + r() * 0.08));
      gross = closes * (30 + Math.floor(r() * 40));
      label = `Shell ${owner.name}`;
    } else {
      const product = st.products.filter(p => p.ghostId === owner.id).slice(-1)[0];
      if (!product) return null;
      const closes = Math.round((ex.score / 50) * r() * 2);
      gross = closes * (product.price > 0 ? product.price : 30);
      label = `Ghost ${owner.name}`;
    }
    if (gross > 0) {
      const cut = split(gross, label, ex, `human loop (${loop.kind})`);
      return `🤝 ${label} human loop: ${money(gross)} gross via ${ex.name} (${money(cut.humanCut)} paid out).`;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Auto-distribution — "system detects high performers, gives them more work"
   * ------------------------------------------------------------------ */
  function autoAssign() {
    const st = S().state;
    const out = [];
    const ops = [];
    st.shells.forEach(s => {
      ops.push({ type: "shell", id: s.id, role: "DM Closer", shell: s });
      if (s.posts.length) ops.push({ type: "shell", id: s.id, role: "Designer", shell: s });
    });
    st.products.slice(-4).forEach(p => {
      ops.push({ type: "product", id: p.id, role: "Copy Editor", product: p });
      ops.push({ type: "product", id: p.id, role: "VA", product: p });
      ops.push({ type: "product", id: p.id, role: "Cold Email Closer", product: p });
    });
    const openCount = id => st.mtasks.filter(t => t.executorId === id && t.status === "assigned").length;
    let assigned = 0;
    for (const op of ops) {
      if (assigned >= 3) break;
      const ex = bestExecutor(op.role);
      if (!ex || openCount(ex.id) >= 2) continue;
      const dupe = st.mtasks.some(t => t.executorId === ex.id && t.sourceId === op.id && t.status !== "scored");
      if (dupe) continue;
      const t = assignTask(ex.id, op);
      if (t) { out.push(`⚡ Auto-assigned "${t.title}" → ${ex.name} (score ${ex.score}).`); assigned++; }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Daily processing on the shared sim clock
   * ------------------------------------------------------------------ */
  function process() {
    const st = S().state;
    const events = [];
    let changed = false;

    /* auto-deliver tasks past deadline */
    st.mtasks.filter(t => t.status === "assigned" && now() >= t.deadline).forEach(t => {
      deliver(t);
      changed = true;
      const ex = st.executors.find(x => x.id === t.executorId);
      events.push(`📦 ${ex ? ex.name : "Executor"} delivered "${t.title}"${t.revenue ? ` — ${money(t.revenue)} attributed` : ""}. Score it in the Matrix.`);
    });

    /* funnels + standing loops, one pass per elapsed sim day */
    const last = st.matrixLastRun;
    let days = last == null ? (st.superFunnels.length || anyLoop() ? 1 : 0) : Math.floor((now() - last) / DAY);
    days = Math.min(days, 10);
    if (days > 0) {
      for (let i = 0; i < days; i++) {
        st.superFunnels.filter(f => f.active).forEach(f => {
          const e2 = runFunnelDay(f, f.stats.days);
          if (e2) events.push(e2);
        });
        st.shells.forEach(s => { const e2 = runLoopDay(s, "shell", i + (s.daily ? s.daily.length : 0)); if (e2) events.push(e2); });
        st.ghosts.forEach(g => { const e2 = runLoopDay(g, "ghost", i); if (e2) events.push(e2); });
      }
      st.matrixLastRun = now();
      changed = true;
    }
    if (changed) S().save();
    return events;
  }
  function anyLoop() {
    const st = S().state;
    return st.shells.some(s => s.humanLoop) || st.ghosts.some(g => g.humanLoop);
  }

  /* ------------------------------------------------------------------ *
   * Task Grid — the real-time task map
   * ------------------------------------------------------------------ */
  function taskGrid() {
    const st = S().state;
    const tiles = [];
    /* AI (green): clone tasks + tracking products + shell drops */
    st.tasks.slice(-8).forEach(t => {
      const c = st.clones.find(x => x.id === t.cloneId);
      tiles.push({ kind: "ai", tag: "AI", title: `${t.type} — ${t.topic}`, who: c ? c.name : "clone", value: t.simEarnings || 0, status: t.rating ? "done" : "live", at: t.createdAt });
    });
    st.products.filter(p => p.status === "tracking").forEach(p => {
      const g = st.ghosts.find(x => x.id === p.ghostId);
      tiles.push({ kind: "ai", tag: "AI", title: `Tracking "${p.name}"`, who: g ? g.name : "ghost", value: G().totalRev(p), status: "live", at: p.launchedAt });
    });
    st.shells.forEach(s => {
      const d = s.daily[s.daily.length - 1];
      if (d) tiles.push({ kind: "ai", tag: "AI", title: `Daily drop ×${s.postsPerDay}`, who: s.name, value: d.income, status: "live", at: s.lastRunAt || s.createdAt });
    });
    /* Human (blue) */
    st.mtasks.slice(-12).forEach(t => {
      const ex = st.executors.find(x => x.id === t.executorId);
      tiles.push({
        kind: "human", tag: "HU", title: t.title, who: ex ? ex.name : "executor",
        value: t.revenue || 0,
        status: t.status === "assigned" ? "live" : t.status === "delivered" ? "review" : "done",
        at: t.createdAt, taskId: t.id
      });
    });
    /* Joint (purple): superfunnels + human loops */
    st.superFunnels.filter(f => f.active).forEach(f => {
      tiles.push({ kind: "joint", tag: "JT", title: `SuperFunnel: ${f.name}`, who: "hybrid", value: f.stats.gross, status: "live", at: f.createdAt });
    });
    st.shells.filter(s => s.humanLoop).forEach(s => {
      const ex = st.executors.find(x => x.id === s.humanLoop.executorId);
      tiles.push({ kind: "joint", tag: "JT", title: `Loop: ${s.name} → ${ex ? ex.name : "?"}`, who: "hybrid", value: 0, status: "live", at: s.createdAt });
    });
    st.ghosts.filter(g => g.humanLoop).forEach(g => {
      const ex = st.executors.find(x => x.id === g.humanLoop.executorId);
      tiles.push({ kind: "joint", tag: "JT", title: `Loop: ${g.name} → ${ex ? ex.name : "?"}`, who: "hybrid", value: 0, status: "live", at: g.createdAt });
    });
    return tiles;
  }

  function stats() {
    const st = S().state;
    const inFlight = st.mtasks.filter(t => t.status !== "scored").length;
    const grossRouted = st.ledger.reduce((a, l) => a + l.gross, 0);
    const paidHumans = st.ledger.reduce((a, l) => a + l.toHuman, 0);
    return {
      executors: st.executors.filter(x => x.active).length,
      inFlight,
      grossRouted,
      paidHumans,
      reinvestPool: st.reinvestPool,
      vaultBalance: st.vaultBalance,
      funnels: st.superFunnels.filter(f => f.active).length
    };
  }

  return {
    ROLES, PERMISSIONS, LOOP_KINDS, GHOST_COST,
    onboard, removeExecutor, bestExecutor,
    assignTask, deliver, scoreTask, buildBrief,
    split, weeklyReportLines, reinvestIntoGhost, withdraw,
    createSuperFunnel, autoAssign, process, taskGrid, stats, agentLabel, money
  };
})();
