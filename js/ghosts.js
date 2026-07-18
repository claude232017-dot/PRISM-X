/* PRISM-X — ghosts.js · PHASE 2: PRODUCT GHOSTS
 * Self-cloning product agents: detect demand → ideate → build assets →
 * launch → track 7 days → evolve (hit ⇒ spawn sub-ghost · miss ⇒ auto-relaunch
 * with a new angle + urgency headline · second miss ⇒ retire & flag).
 *
 * Honesty note: market signals and revenue are a labeled simulation driven by
 * a per-product quality seed (a serverless app can't scrape or take payments).
 * The ASSETS are real — sales pages, launch threads and DM flows are generated
 * by the Local Cortex or live via the Neural Link, and launch threads flow
 * into the Broadcast Queue for actual posting.
 */
window.PRISM = window.PRISM || {};

PRISM.ghosts = (function () {
  "use strict";
  const D = () => PRISM.data, E = () => PRISM.engine, S = () => PRISM.store, U = () => PRISM.ui;
  const DAY = 86400000;
  const TRACK_DAYS = 7;

  /* ------------------------------------------------------------------ *
   * Static catalogs
   * ------------------------------------------------------------------ */
  const PRODUCT_TYPES = ["Mini-course", "Ebook", "AI prompt pack", "Crypto sniper alert group", "Notion template", "Affiliate review site"];
  const PLATFORMS = ["Gumroad", "Lemon Squeezy", "Payhip", "Teachable", "Kajabi", "Twitter threads (viral launch)"];
  const PLATFORM_FACTOR = { "Gumroad": 1.0, "Lemon Squeezy": 0.95, "Payhip": 0.9, "Teachable": 1.05, "Kajabi": 1.1, "Twitter threads (viral launch)": 1.15 };

  const GHOST_SKILLS = [
    "Market scanning", "Copywriting", "Offer stacking", "Funnel logic",
    "Urgency + CTA formatting", "Sales page generation", "Launch content (tweets, DMs, emails)"
  ];

  const NICHES = [
    "AI side hustles", "fitness coaches", "crypto beginners", "notion productivity",
    "freelance writers", "e-com founders", "dating confidence", "language learning",
    "indie hackers", "personal finance", "content creators", "remote job seekers"
  ];

  const TEMPLATES = [
    { name: "CASHSCRIPT",   focus: "Copywriting Prompt Pack",     type: "AI prompt pack",           niche: "content creators",   tone: "Direct",      example: `"50 Emotional Hooks for Coaches"` },
    { name: "VAULTGHOST",   focus: "Digital Guide Creation",      type: "Ebook",                    niche: "crypto beginners",   tone: "Calm Alpha",  example: `"Beginner's Guide to Crypto in 2026"` },
    { name: "IDEAFIEND",    focus: "Course Launcher",             type: "Mini-course",              niche: "AI side hustles",    tone: "Persuasive",  example: `"Mini course on AI DM Closing"` },
    { name: "TRENDDRIP",    focus: "Notion Systems Builder",      type: "Notion template",          niche: "notion productivity", tone: "Entertainer", example: `"Daily Discipline Planner + Sales CRM"` },
    { name: "REVIEWREAPER", focus: "Affiliate Comparison Page",   type: "Affiliate review site",    niche: "indie hackers",      tone: "Direct",      example: `"Top 3 AI Tools Ranked (2026)"` }
  ];

  const PAINS = [
    { pain: "posting daily but converting none of it into buyers", src: "X threads" },
    { pain: "drowning in scattered notes and half-finished systems", src: "Reddit r/productivity" },
    { pain: "getting ghosted the moment they mention a price", src: "X DM screenshots" },
    { pain: "buying courses they never finish and trusting no one twice", src: "YouTube comments" },
    { pain: "spending hours writing copy that sounds like everyone else's AI slop", src: "Reddit r/copywriting" },
    { pain: "not knowing which tool to pick and fearing the wrong bet", src: "YouTube comparison comments" },
    { pain: "starting over every Monday because no system survives a bad week", src: "X threads" },
    { pain: "watching smaller accounts monetize while they stay stuck at zero", src: "X quote-tweets" },
    { pain: "entering late on every trend and exiting later", src: "Reddit r/CryptoCurrency" },
    { pain: "having the skill but freezing when it's time to sell it", src: "YouTube comments" },
    { pain: "juggling five income ideas and finishing none", src: "Reddit r/sidehustle" },
    { pain: "hating their pitch so much they never send it", src: "X threads" }
  ];

  const ANGLES = ["speed ('results in 7 days, not 7 months')", "done-for-you ('steal the system, skip the theory')", "anti-guru ('no fluff, no lambo screenshots')", "proof-first ('receipts before promises')", "beginner-safe ('assumes zero, delivers one')"];
  const URGENCY_HEADLINES = [
    "48 hours only: the price doubles Friday.",
    "17 copies left at launch price — then it's gone.",
    "Founding buyers get lifetime updates. Doors close Sunday.",
    "Launch week bonus vanishes at midnight."
  ];

  const SUGGESTIONS = [
    { idea: "a Baki-style Training Tracker template (grind log + PR board + discipline streaks)", type: "Notion template", niche: "fitness coaches" },
    { idea: "an 'followers → first $100' sprint for tiny accounts", type: "Mini-course", niche: "content creators" },
    { idea: "a cold-DM objection flashcard pack", type: "AI prompt pack", niche: "freelance writers" },
    { idea: "a 'first 30 days of remote work' survival guide", type: "Ebook", niche: "remote job seekers" },
    { idea: "a side-by-side teardown of the top 3 AI writing tools", type: "Affiliate review site", niche: "indie hackers" },
    { idea: "a weekly narrative-rotation briefing group", type: "Crypto sniper alert group", niche: "crypto beginners" }
  ];

  const ROMAN = ["", "", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

  /* ------------------------------------------------------------------ *
   * Sim clock — Fast-forward advances ghost-market time only.
   * ------------------------------------------------------------------ */
  function now() { return Date.now() + (S().state.ghostSimOffset || 0); }
  function fastForward(days) {
    S().state.ghostSimOffset = (S().state.ghostSimOffset || 0) + days * DAY;
    S().save();
  }

  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const money = n => "$" + Math.round(n).toLocaleString();

  /* ------------------------------------------------------------------ *
   * Ideation
   * ------------------------------------------------------------------ */
  function titleCase(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }

  function productName(r, type, niche) {
    const N = titleCase(niche);
    const year = new Date().getFullYear();
    switch (type) {
      case "Ebook": return `The ${N} ${pick(r, ["Playbook", "Blueprint", "Field Manual"])}`;
      case "AI prompt pack": return `${pick(r, [50, 75, 100])} ${pick(r, ["Emotional Hooks", "Conversion Prompts", "Closing Lines"])} for ${N}`;
      case "Mini-course": return `${N} ${pick(r, ["Accelerator", "Launchpad", "Sprint"])}: ${pick(r, ["Zero to First Sale", "7 Days to Momentum", "The Fast Lane"])}`;
      case "Notion template": return `${N} ${pick(r, ["OS", "Command Center", "Engine"])}`;
      case "Crypto sniper alert group": return `${N} ${pick(r, ["Sniper Signals", "Narrative Radar", "Alpha Room"])}`;
      case "Affiliate review site": return `Top ${pick(r, [3, 5])} ${N} Tools Ranked (${year})`;
      default: return `${N} System`;
    }
  }

  function priceFor(r, type) {
    const ranges = {
      "Ebook": [17, 47], "AI prompt pack": [9, 29], "Mini-course": [47, 197],
      "Notion template": [19, 49], "Crypto sniper alert group": [29, 99],
      "Affiliate review site": [0, 0]
    };
    const [lo, hi] = ranges[type] || [19, 49];
    if (hi === 0) return 0; /* affiliate: commission-based */
    const raw = lo + r() * (hi - lo);
    return Math.max(7, Math.round(raw / 2) * 2 - 1); /* odd pricing */
  }

  function demandSignal(r, niche, pain) {
    const posts = 120 + Math.floor(r() * 320);
    const subs = 2 + Math.floor(r() * 4);
    const yts = 30 + Math.floor(r() * 90);
    return `[SIMULATED SCAN] ${posts} X posts · ${subs} subreddits · ${yts} YouTube comments in "${niche}" → recurring pain: ${pain.pain} (loudest on ${pain.src}).`;
  }

  /* ------------------------------------------------------------------ *
   * Asset generation (Local Cortex; Neural Link when enabled)
   * ------------------------------------------------------------------ */
  function buildAssetsLocal(ghost, product, r) {
    const dna = S().state.dna || {};
    const tone = D().TONES[ghost.tone] || D().TONES["Direct"];
    const cta = dna.cta && r() < 0.5 ? dna.cta : pick(r, tone.ctas);
    const priceLine = product.price > 0 ? `${money(product.price)} launch price` : "free page, monetized via affiliate commissions";
    const testimonial = ghostHits(ghost).length
      ? `\n"${pick(r, ["Bought it, applied it same day, made the price back by Friday.", "This is the first one of these that actually ships a system.", "Refreshingly free of guru fluff."])}" — early buyer of ${ghostHits(ghost)[0].name}`
      : "";

    const salesPage = [
      `# ${product.name}`,
      product.urgencyHeadline ? `⚡ ${product.urgencyHeadline}` : "",
      ``,
      `**For ${product.niche} tired of ${product.pain.pain}.**`,
      ``,
      `${pick(r, tone.hooks)} ${pick(r, tone.bridges)} this fixes the exact problem your feed complains about daily.`,
      ``,
      `## What you get`,
      `• The core ${product.type.toLowerCase()} — angle: ${product.angle}`,
      `• Quick-start walkthrough (15 minutes to first result)`,
      `• Copy-paste examples tuned for ${product.niche}`,
      `• Lifetime updates while it's live`,
      testimonial,
      ``,
      `## Price`,
      `${priceLine}. ${product.price > 0 ? "Guarantee: results in 30 days or a full refund." : ""}`,
      ``,
      `**CTA:** ${cta}`,
      product.type === "Crypto sniper alert group" ? `\n⚠ Educational content only — not financial advice.` : ""
    ].filter(x => x !== "").join("\n");

    const thread = [
      `1/ ${pick(r, tone.hooks)} ${product.niche} keep saying the same thing: "${product.pain.pain}".`,
      `2/ So I built ${product.name} — ${product.type.toLowerCase()}, angle: ${product.angle}.`,
      `3/ ${pick(r, tone.bridges)} it's built from what the market is literally asking for (${product.pain.src}).`,
      `4/ Inside: the system, the walkthrough, the copy-paste examples. No filler.`,
      `5/ ${product.urgencyHeadline || `Launch price: ${priceLine}.`}`,
      `6/ ${pick(r, tone.closers)} ${cta}`
    ].join("\n\n");

    const dmFlow = [
      `DM 1 (warm lead): "Saw you post about ${product.niche} — the '${product.pain.pain}' problem. Built something for exactly that. Want the link?"`,
      `DM 2 (+2d): "No pressure — here's one free win from it: lead with proof, not promises. The rest is in ${product.name}."`,
      `DM 3 (+5d): "${product.urgencyHeadline || "Closing the launch window soon."} Last nudge. ${cta}"`
    ].join("\n\n");

    return { salesPage, thread, dmFlow, cta };
  }

  async function buildAssets(ghost, product, r) {
    const st = S().state;
    /* Phase H0: the Provider Manager decides which provider builds assets */
    const P = window.PRISM && PRISM.providers ? PRISM.providers : null;
    const sel = P ? P.resolve(ghost.provider || "auto", "Copywriting / content")
      : { id: (st.settings.engine === "neural" && st.settings.apiKey) ? "claude" : "local", switched: false };
    if (sel.id === "claude") {
      try {
        const dna = st.dna || {};
        const sys = [
          `You are ${ghost.name}, a Product Ghost inside PRISM-X — an autonomous digital-product agent.`,
          `Tone: ${ghost.tone}. ${D().TONES[ghost.tone] ? D().TONES[ghost.tone].desc : ""}`,
          dna.decision ? `Decision Framework (non-negotiable operating laws):\n${dna.decision}` : "",
          dna.cta ? `Prefer this signature CTA where natural: ${dna.cta}` : "",
          `Output plain text in exactly three sections separated by lines "=== SALES PAGE ===", "=== LAUNCH THREAD ===", "=== DM FLOW ===".`
        ].filter(Boolean).join("\n");
        const prompt = [
          `Product: ${product.name} (${product.type}) at ${product.price > 0 ? "$" + product.price : "free / affiliate-monetized"}.`,
          `Niche: ${product.niche}. Validated pain point: "${product.pain.pain}" (seen on ${product.pain.src}).`,
          `Angle: ${product.angle}.`,
          product.urgencyHeadline ? `Urgency headline to feature: ${product.urgencyHeadline}` : "",
          `Write: (1) a complete sales page, (2) a 6-tweet launch thread, (3) a 3-touch DM flow.`
        ].filter(Boolean).join("\n");
        const text = await E().complete(sys, prompt, st.settings,
          { workerId: ghost.id, workerName: ghost.name, provider: ghost.provider || "auto", category: "Copywriting / content" });
        const cut = (a, b) => {
          const i = text.indexOf(a);
          if (i < 0) return "";
          const j = b ? text.indexOf(b, i) : -1;
          return text.slice(i + a.length, j > 0 ? j : undefined).trim();
        };
        const salesPage = cut("=== SALES PAGE ===", "=== LAUNCH THREAD ===");
        const thread = cut("=== LAUNCH THREAD ===", "=== DM FLOW ===");
        const dmFlow = cut("=== DM FLOW ===", null);
        if (salesPage && thread) {
          product.engine = "neural";
          return { salesPage, thread, dmFlow: dmFlow || buildAssetsLocal(ghost, product, r).dmFlow, cta: "" };
        }
      } catch (e) { /* fall through to local */ }
    }
    product.engine = "local";
    const assets = buildAssetsLocal(ghost, product, r);
    if (P) P.recordLocal({
      workerId: ghost.id, workerName: ghost.name,
      requested: sel.requested, switched: sel.switched, reason: sel.reason,
      chars: (assets.salesPage || "").length + (assets.thread || "").length
    });
    return assets;
  }

  /* ------------------------------------------------------------------ *
   * Revenue simulation — a per-product quality seed decides its fate.
   * Expected daily revenue ≈ quality × ghost target income.
   * ------------------------------------------------------------------ */
  function dayRevenue(product, dayIdx) {
    const r = E().rng(E().hashStr(product.id + ":day:" + dayIdx + ":" + (product.relaunchCount || 0)));
    const decay = Math.max(0.35, 1.55 - dayIdx * 0.17);      /* launch spike then cool-off */
    const jitter = 0.45 + r() * 1.1;
    const urgency = product.urgencyHeadline ? 1.18 : 1;
    const superB = product.super ? 1.25 : 1;
    const pf = PLATFORM_FACTOR[product.platform] || 1;
    const unit = product.price > 0 ? product.price : 14;      /* affiliate: avg commission */
    const expected = (product.quality * product.targetIncome) / unit;
    const sales = Math.max(0, Math.round(expected * jitter * decay * urgency * superB * pf));
    return { sales, revenue: sales * unit, visits: sales * (8 + Math.floor(r() * 18)) + Math.floor(r() * 40) };
  }

  function ensureTracking(product) {
    if (product.status !== "tracking") return false;
    const elapsed = Math.floor((now() - product.launchedAt) / DAY);
    const target = Math.min(TRACK_DAYS, elapsed);
    let changed = false;
    product.daily = product.daily || [];
    while (product.daily.length < target) {
      product.daily.push(dayRevenue(product, product.daily.length));
      changed = true;
    }
    return changed;
  }

  const totalRev = p => (p.daily || []).reduce((a, d) => a + d.revenue, 0);
  const totalSales = p => (p.daily || []).reduce((a, d) => a + d.sales, 0);

  function ghostProducts(ghost) { return S().state.products.filter(p => p.ghostId === ghost.id); }
  function ghostHits(ghost) { return ghostProducts(ghost).filter(p => p.status === "hit"); }
  function ghostRevenue(ghost) { return ghostProducts(ghost).reduce((a, p) => a + totalRev(p), 0); }

  /* ------------------------------------------------------------------ *
   * Ghost lifecycle
   * ------------------------------------------------------------------ */
  function uidStamp(prefix) { return S().uid(prefix); }

  function createGhost(input) {
    const st = S().state;
    const niche = (!input.niche || input.niche.toLowerCase() === "random")
      ? pick(E().rng(E().hashStr("niche" + Date.now())), NICHES)
      : input.niche.trim();
    const g = {
      id: uidStamp("gh"),
      name: (input.name || "GHOST").toUpperCase(),
      template: input.template || "custom",
      focus: input.focus || input.productType,
      niche,
      targetIncome: Math.max(10, parseInt(input.targetIncome, 10) || 100),
      productType: input.productType,
      platform: input.platform,
      tone: input.tone,
      provider: input.provider || "auto",
      skills: GHOST_SKILLS.slice(),
      createdAt: now(),
      generation: input.generation || 1,
      parentId: input.parentId || null,
      super: !!input.super,
      merged: input.merged || null,
      lastLaunchAt: null,
      retiredFlag: false,
      memory: input.memory ? input.memory.slice() : []
    };
    g.memory.push(`Trained in: ${GHOST_SKILLS.join(" · ")}.`);
    if (st.dna && st.dna.decision) g.memory.push(`Decision Framework inherited from GOD CORE (brain v${st.godBrainVersion}).`);
    st.ghosts.push(g);
    S().logMemory("ghost", `👻 Product Ghost "${g.name}" deployed — ${g.productType} · ${g.niche} · target ${money(g.targetIncome)}/day.`);
    S().save();
    return g;
  }

  /* One full autonomous cycle: detect → ideate → build → launch. */
  async function runCycle(ghost, opts) {
    opts = opts || {};
    const r = E().rng(E().hashStr(ghost.id + ":cycle:" + now()));
    const pain = opts.pain || pick(r, PAINS);
    const type = opts.type || ghost.productType;
    const product = {
      id: uidStamp("pr"),
      ghostId: ghost.id,
      name: opts.name || productName(r, type, ghost.niche),
      type,
      niche: ghost.niche,
      platform: ghost.platform,
      pain,
      signal: demandSignal(r, ghost.niche, pain),
      angle: opts.angle || pick(r, ANGLES),
      price: opts.price != null ? opts.price : priceFor(r, type),
      urgencyHeadline: opts.urgencyHeadline || null,
      targetIncome: ghost.targetIncome,
      quality: 0.35 + r() * 1.15,                   /* the fate seed */
      super: !!ghost.super,
      relaunchCount: opts.relaunchCount || 0,
      relaunchOf: opts.relaunchOf || null,
      launchedAt: now(),
      daily: [],
      status: "tracking",
      engine: "local",
      assets: null
    };
    product.assets = await buildAssets(ghost, product, r);
    S().state.products.push(product);
    ghost.lastLaunchAt = now();
    ghost.retiredFlag = false;
    ghost.memory.push(`Launched "${product.name}" (${money(product.price)}${product.price ? "" : " / affiliate"}) on ${product.platform} — angle: ${product.angle}.`);

    /* real-world hook: queue the launch thread's opener for X */
    const t9 = new Date(); t9.setDate(t9.getDate() + 1); t9.setHours(9, 0, 0, 0);
    S().addQueueItem({
      cloneId: null,
      title: `👻 ${ghost.name} launch — ${product.name}`,
      text: (product.assets.thread.split("\n\n")[0] || product.name).slice(0, 270),
      dueAt: t9.getTime()
    });

    S().logMemory("ghost", `👻 ${ghost.name} launched "${product.name}" — ${money(product.price)} on ${product.platform}.`);
    S().save();
    return product;
  }

  /* Evaluate matured products + enforce the weekly GOD CORE directive.
   * Returns human-readable event lines for the wake-up digest. */
  async function process() {
    const st = S().state;
    const events = [];

    for (const p of st.products) {
      ensureTracking(p);
      if (p.status === "tracking" && (p.daily || []).length >= TRACK_DAYS) {
        const rev = totalRev(p);
        const avg = rev / TRACK_DAYS;
        const ghost = st.ghosts.find(g => g.id === p.ghostId);
        if (avg >= p.targetIncome) {
          p.status = "hit";
          events.push(`📈 "${p.name}" hit target: ${money(rev)} in ${TRACK_DAYS} days (${money(avg)}/day avg).`);
          if (ghost && !p.evolved) {
            p.evolved = true;
            const sub = spawnSubGhost(ghost, p);
            events.push(`🌀 ${ghost.name} duplicated into sub-ghost ${sub.name} (gen ${sub.generation}).`);
          }
        } else if ((p.relaunchCount || 0) === 0) {
          p.status = "relaunched";
          events.push(`⚠ "${p.name}" under target (${money(avg)}/day vs ${money(p.targetIncome)}) — relaunching with urgency headline + new angle.`);
          if (ghost) {
            const r = E().rng(E().hashStr(p.id + ":relaunch"));
            await runCycle(ghost, {
              name: p.name + " (Relaunch)",
              pain: p.pain,
              type: p.type,
              angle: pick(r, ANGLES.filter(a => a !== p.angle)),
              price: p.price > 0 ? Math.max(7, Math.round(p.price * (r() < 0.5 ? 0.8 : 1.2))) : 0,
              urgencyHeadline: pick(r, URGENCY_HEADLINES),
              relaunchCount: 1,
              relaunchOf: p.id
            });
          }
        } else {
          p.status = "retired";
          if (ghost) { ghost.retiredFlag = true; ghost.memory.push(`"${p.name}" retired after relaunch — needs a new niche angle.`); }
          events.push(`✖ "${p.name}" retired after relaunch. ${ghost ? ghost.name + " flagged: needs a new angle." : ""}`);
        }
        S().logMemory("ghost", events[events.length - 1]);
      }
    }

    /* GOD CORE directive: ≥1 monetized product per ghost per week */
    for (const g of st.ghosts.slice()) {
      if (g.merged === "absorbed") continue;
      const active = ghostProducts(g).some(p => p.status === "tracking");
      const overdue = !g.lastLaunchAt || (now() - g.lastLaunchAt) > TRACK_DAYS * DAY;
      if (!active && overdue && !g.retiredFlag) {
        const p = await runCycle(g);
        events.push(`👻 Directive: ${g.name} launched "${p.name}" — ${money(p.price)} on ${p.platform}.`);
      }
    }

    S().save();
    return events;
  }

  function spawnSubGhost(parent, product) {
    const r = E().rng(E().hashStr(parent.id + ":spawn:" + product.id));
    const gen = (parent.generation || 1) + 1;
    const base = parent.name.replace(/\s+(II|III|IV|V|VI|VII|VIII|IX|X)$/i, "");
    const name = `${base} ${ROMAN[Math.min(gen, 10)] || gen}`;
    /* directive: each ghost operates in a different niche */
    const niche = pick(r, NICHES.filter(n => n !== parent.niche));
    return createGhost({
      name,
      template: parent.template,
      focus: parent.focus,
      niche,
      targetIncome: Math.round(parent.targetIncome * 1.25),
      productType: parent.productType,
      platform: parent.platform,
      tone: parent.tone,
      generation: gen,
      parentId: parent.id,
      super: parent.super,
      memory: [`Spawned from ${parent.name} after "${product.name}" hit target (${money(totalRev(product))}).`]
    });
  }

  function cloneBestSeller() {
    const st = S().state;
    const hits = st.products.filter(p => p.status === "hit").sort((a, b) => totalRev(b) - totalRev(a));
    if (!hits.length) return null;
    const best = hits[0];
    const ghost = st.ghosts.find(g => g.id === best.ghostId);
    if (!ghost) return null;
    return spawnSubGhost(ghost, best);
  }

  async function relaunchFailed() {
    const st = S().state;
    const failed = st.products.filter(p => p.status === "retired");
    const done = [];
    for (const p of failed.slice(0, 3)) {
      const ghost = st.ghosts.find(g => g.id === p.ghostId);
      if (!ghost) continue;
      const r = E().rng(E().hashStr(p.id + ":manual-relaunch:" + now()));
      p.status = "relaunched";
      const np = await runCycle(ghost, {
        name: p.name.replace(/ \(Relaunch.*\)$/, "") + " (Relaunch v2)",
        pain: p.pain, type: p.type,
        angle: pick(r, ANGLES.filter(a => a !== p.angle)),
        price: p.price > 0 ? Math.max(7, Math.round(p.price * 0.8)) : 0,
        urgencyHeadline: pick(r, URGENCY_HEADLINES),
        relaunchCount: 0, relaunchOf: p.id
      });
      done.push(np);
    }
    return done;
  }

  function mergeGhosts(idA, idB) {
    const st = S().state;
    const a = st.ghosts.find(g => g.id === idA), b = st.ghosts.find(g => g.id === idB);
    if (!a || !b || a === b) return null;
    let name = (a.name.slice(0, Math.ceil(a.name.length / 2)) + b.name.slice(Math.floor(b.name.length / 2))).toUpperCase().slice(0, 14).trim();
    if (st.ghosts.some(g => g.name === name)) name = (name + " PRIME").slice(0, 20);
    const merged = createGhost({
      name,
      template: "superagent",
      focus: `${a.focus} × ${b.focus}`,
      niche: a.niche,
      targetIncome: Math.max(a.targetIncome, b.targetIncome) + Math.min(a.targetIncome, b.targetIncome) / 2 | 0,
      productType: a.productType,
      platform: a.platform,
      tone: a.tone,
      generation: Math.max(a.generation, b.generation) + 1,
      super: true,
      merged: [a.name, b.name],
      memory: [`SuperAgent forged from ${a.name} + ${b.name} — hybrid skill matrix, +25% conversion quality on all future products.`]
    });
    [a, b].forEach(g => { g.merged = "absorbed"; g.memory.push(`Absorbed into SuperAgent ${merged.name}.`); });
    S().logMemory("ghost", `🤖 SuperAgent ${merged.name} forged from ${a.name} + ${b.name}.`);
    S().save();
    return merged;
  }

  function deleteGhost(id) {
    const st = S().state;
    const g = st.ghosts.find(x => x.id === id);
    st.ghosts = st.ghosts.filter(x => x.id !== id);
    st.products = st.products.filter(p => p.ghostId !== id);
    if (g) S().logMemory("ghost", `👻 Ghost "${g.name}" decommissioned.`);
    S().save();
  }

  function ghostStatus(g) {
    if (g.merged === "absorbed") return { label: "ABSORBED", cls: "gst-dormant" };
    if (g.retiredFlag) return { label: "NEEDS ANGLE", cls: "gst-needs" };
    const ps = ghostProducts(g);
    if (ps.some(p => p.status === "tracking")) return { label: "TRACKING", cls: "gst-track" };
    if (ps.some(p => p.status === "hit")) return { label: "SCALING", cls: "gst-hit" };
    return { label: "SCANNING", cls: "gst-scan" };
  }

  function stats() {
    const st = S().state;
    const live = st.ghosts.filter(g => g.merged !== "absorbed");
    const revenue = st.products.reduce((a, p) => a + totalRev(p), 0);
    const hits = st.products.filter(p => p.status === "hit").length;
    const launched = st.products.length;
    return { ghosts: live.length, revenue, hits, launched, hitRate: launched ? Math.round(hits / launched * 100) : 0 };
  }

  function weeklyReport() {
    const st = S().state;
    const since = now() - TRACK_DAYS * DAY;
    const recent = st.products.filter(p => p.launchedAt >= since);
    const r = E().rng(E().hashStr("suggest:" + Math.floor(now() / DAY)));
    const sug = pick(r, SUGGESTIONS);
    return {
      launches: recent.length,
      revenue: recent.reduce((a, p) => a + totalRev(p), 0),
      hits: st.products.filter(p => p.status === "hit"),
      relaunched: st.products.filter(p => p.status === "relaunched").length,
      retired: st.products.filter(p => p.status === "retired").length,
      perGhost: st.ghosts.filter(g => g.merged !== "absorbed").map(g => ({ g, revenue: ghostRevenue(g), products: ghostProducts(g).length })),
      suggestion: sug
    };
  }

  return {
    PRODUCT_TYPES, PLATFORMS, TEMPLATES, GHOST_SKILLS, NICHES, TRACK_DAYS,
    now, fastForward, createGhost, runCycle, process, spawnSubGhost,
    cloneBestSeller, relaunchFailed, mergeGhosts, deleteGhost,
    ghostStatus, ghostProducts, ghostRevenue, totalRev, totalSales,
    stats, weeklyReport, money
  };
})();
