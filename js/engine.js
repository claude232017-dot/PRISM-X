/* PRISM-X — engine.js
 * The generation cortex. Two modes:
 *   - Local Cortex: offline combinatorial templates (always available)
 *   - Neural Link: live Claude API calls with the clone's DNA as system prompt
 * Also: performance simulation, status derivation, weekly audit.
 */
window.PRISM = window.PRISM || {};

PRISM.engine = (function () {
  "use strict";
  const D = PRISM.data;

  /* ---------------- seeded RNG (mulberry32) ---------------- */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

  /* ---------------- local generators ---------------- */
  /* Every generator returns { artifactLabel, artifact, plan[], cta, notes[] } */

  function ctxLines(ctx) {
    const out = [];
    if (ctx.niche) out.push(`Niche lens: ${ctx.niche} — every line speaks their language.`);
    if (ctx.objection) out.push(`Pre-handle the objection "${ctx.objection}" before the ask.`);
    if (ctx.urgency) out.push(D.URGENCY_LINES[ctx.urgency] || "");
    return out.filter(Boolean);
  }

  function flipFor(ctx, r) {
    if (ctx.objection) {
      const known = D.OBJECTION_FLIPS.find(([k]) => ctx.objection.toLowerCase().includes(k.split(" ")[1] || k));
      if (known) return known[1];
      return `Name it before they do: "You might be thinking ${ctx.objection} — here's why that's exactly backwards…" then give one proof point.`;
    }
    return pick(r, D.OBJECTION_FLIPS)[1];
  }

  const GEN = {
    "Write Tweet": (ctx, t, r) => ({
      artifactLabel: "Tweet",
      artifact: [
        `${pick(r, t.hooks)}`,
        ``,
        `${ctx.topic} = ${pick(r, D.BENEFITS)}.`,
        ``,
        `${pick(r, t.bridges)}`,
        `• ${pick(r, D.PROOFS)}`,
        `• ${pick(r, D.PROOFS)}`,
        ``,
        `${ctx.cta}`
      ].join("\n"),
      plan: [
        "Post at your audience's peak hour (check last 7 days of analytics).",
        "Reply to the first 5 comments within 15 minutes to feed the algorithm.",
        `Pin it if engagement beats your median by hour two.`,
        `Log replies mentioning "${ctx.topic}" as warm leads.`
      ]
    }),

    "Write Thread": (ctx, t, r) => ({
      artifactLabel: "Thread (7 tweets)",
      artifact: [
        `1/ ${pick(r, t.hooks)} ${ctx.topic} — a thread worth your next 90 seconds.`,
        `2/ The problem: everyone chases tactics. Nobody installs a system. ${pick(r, t.bridges)}`,
        `3/ Receipt: ${pick(r, D.PROOFS)}.`,
        `4/ Step 1 — nail one promise: "${ctx.outcome || pick(r, D.BENEFITS)}".`,
        `5/ Step 2 — one channel, one offer, one CTA. Ruthlessly one.`,
        `6/ Step 3 — ${flipFor(ctx, r)}`,
        `7/ ${pick(r, t.closers)} ${ctx.cta}`
      ].join("\n\n"),
      plan: [
        "Publish tweets 1–7 as a native thread; hook stands alone.",
        "Quote-retweet it yourself after 6 hours with a bonus tip.",
        "DM everyone who bookmarks or replies with intent."
      ]
    }),

    "Write Caption": (ctx, t, r) => ({
      artifactLabel: "Caption",
      artifact: [
        `${pick(r, t.hooks)}`,
        ``,
        `${ctx.topic}. ${pick(r, t.bridges)} ${pick(r, D.BENEFITS)} — and ${pick(r, D.PROOFS)}.`,
        ``,
        `${pick(r, t.closers)}`,
        `${ctx.cta}`,
        ``,
        `#${(ctx.niche || "growth").replace(/\s+/g, "")} #systems #leverage`
      ].join("\n"),
      plan: ["Pair with a bold 3-word visual.", "Reuse the hook as the image headline.", "Respond to every comment with a question to double reach."]
    }),

    "Email Copy": (ctx, t, r) => ({
      artifactLabel: "Email",
      artifact: [
        `SUBJECT: ${pick(r, t.hooks).replace(/[.:]$/, "")} (${ctx.topic})`,
        ``,
        `Hey {first_name},`,
        ``,
        `${pick(r, t.bridges)} ${pick(r, D.BENEFITS)}.`,
        ``,
        `${pick(r, D.PROOFS).charAt(0).toUpperCase() + pick(r, D.PROOFS).slice(1)}.`,
        ``,
        `${flipFor(ctx, r)}`,
        ``,
        `${pick(r, t.closers)}`,
        ``,
        `${ctx.cta}`,
        ``,
        `— ${ctx.cloneName}`
      ].join("\n"),
      plan: ["Send Tue/Thu morning; split-test the subject against a question form.", "Plain text beats design for reply-goal emails.", "Follow up in 48h to non-openers with a new subject only."]
    }),

    "Opening DM": (ctx, t, r) => ({
      artifactLabel: "Opening DM",
      artifact: [
        `Hey {name} — saw your post about ${ctx.topic}. ${pick(r, t.hooks)}`,
        ``,
        `Genuine question: are you getting ${ctx.outcome || pick(r, D.BENEFITS)} from it yet, or is it still manual?`,
        ``,
        `(No pitch — just curious. I ${pick(r, D.PROOFS)}.)`
      ].join("\n"),
      plan: ["Send to 10 warm profiles (engaged with your content in 72h).", "Never pitch in message one — earn the reply.", "If they answer, move to the Close DM script."]
    }),

    "Close DM": (ctx, t, r) => ({
      artifactLabel: "Closing DM script",
      artifact: [
        `THEM: interested but hesitant about ${ctx.topic}.`,
        ``,
        `YOU: "${pick(r, t.bridges)} you want ${ctx.outcome || pick(r, D.BENEFITS)} — that's exactly what this is built for."`,
        ``,
        `YOU: "${flipFor(ctx, r)}"`,
        ``,
        `YOU: "${pick(r, t.closers)} ${ctx.cta}"`,
        ``,
        `IF SILENT 24H → "${pick(r, t.hooks)} Spots close Friday — want me to hold yours?"`
      ].join("\n"),
      plan: ["Mirror their words back before every ask.", "One question per message. Never two.", "Close on a micro-yes ('want the link?') before the payment ask."]
    }),

    "DM Follow-Up": (ctx, t, r) => ({
      artifactLabel: "Follow-up sequence (3 touches)",
      artifact: [
        `TOUCH 1 (+2 days): "Circling back on ${ctx.topic} — ${pick(r, D.BENEFITS)} still on your radar?"`,
        ``,
        `TOUCH 2 (+5 days): "Quick one: ${pick(r, D.PROOFS)}. Want me to show you how?"`,
        ``,
        `TOUCH 3 (+9 days): "${pick(r, t.closers)} Last nudge from me — ${ctx.cta}"`
      ].join("\n"),
      plan: ["Space touches 2/5/9 days; stop after three.", "Each touch adds NEW value — never 'just bumping this'.", "Archive non-responders into a 30-day re-warm list."]
    }),

    "Objection Handler": (ctx, t, r) => ({
      artifactLabel: "Objection script",
      artifact: [
        `OBJECTION: "${ctx.objection || "it's too expensive"}"`,
        ``,
        `ACKNOWLEDGE: "Totally get it — that's a fair thing to weigh."`,
        ``,
        `REFRAME: "${flipFor(ctx, r)}"`,
        ``,
        `PROOF: "${pick(r, D.PROOFS).charAt(0).toUpperCase() + pick(r, D.PROOFS).slice(1)}."`,
        ``,
        `RE-ASK: "${pick(r, t.closers)} ${ctx.cta}"`
      ].join("\n"),
      plan: ["Acknowledge → reframe → proof → re-ask. Never skip the acknowledge.", "Log every new objection you hear into the vault.", "If the same objection appears 3x, fix the offer page — not the script."]
    }),

    "Build Offer": (ctx, t, r) => ({
      artifactLabel: "Offer stack",
      artifact: [
        `OFFER NAME: "The ${ctx.topic.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")} Engine"`,
        ``,
        `PROMISE: ${ctx.outcome || pick(r, D.BENEFITS)} — or you don't pay.`,
        ``,
        `STACK:`,
        `• Core system: done-with-you ${ctx.topic} build (value $1,500)`,
        `• Swipe vault: every script + template that ${pick(r, D.PROOFS)} (value $400)`,
        `• 2x weekly review calls for 30 days (value $600)`,
        `• Bonus: ${ctx.niche ? ctx.niche + "-specific" : "niche-custom"} playbook (value $250)`,
        ``,
        `PRICE: $497 front-end · $997 with 1:1 tier`,
        `GUARANTEE: results in 30 days or full refund + you keep the vault.`,
        ``,
        `${ctx.cta}`
      ].join("\n"),
      plan: ["Sell the promise, itemize the stack, anchor the price to value 5x.", "Launch to warm list first; use their questions to fix the page.", `${flipFor(ctx, r)}`]
    }),

    "Price & Package": (ctx, t, r) => ({
      artifactLabel: "Pricing matrix",
      artifact: [
        `PRODUCT: ${ctx.topic}`,
        ``,
        `TIER 1 — STARTER  · $197  · templates + community · for validators`,
        `TIER 2 — SYSTEM   · $497  · everything in Starter + build calls · ← anchor here`,
        `TIER 3 — DONE-FOR-YOU · $1,497 · we install it · scarcity: 3/month`,
        ``,
        `RULES:`,
        `• Middle tier is the one you actually sell — price the others to frame it.`,
        `• Annual/lifetime bump: +40% take rate when offered at checkout only.`,
        `• ${pick(r, t.closers)}`
      ].join("\n"),
      plan: ["Present three tiers, recommend the middle.", "Raise price 10% every 10 sales until close-rate dips.", "Add a downsell (vault-only) on exit intent."]
    }),

    "Design Upsell": (ctx, t, r) => ({
      artifactLabel: "Upsell flow",
      artifact: [
        `MAIN PURCHASE: ${ctx.topic}`,
        ``,
        `BUMP (checkout, +$47): quick-start templates — "skip week one".`,
        `UPSELL 1 (post-purchase, +$197): automation layer — "${pick(r, D.BENEFITS)}".`,
        `UPSELL 2 (decline path, +$97): lite version of upsell 1.`,
        ``,
        `COPY KEY: sell speed and certainty, not more stuff.`,
        `${ctx.cta}`
      ].join("\n"),
      plan: ["Bump take-rate target: 30%+. Below that, rewrite the bump headline.", "One-click upsell; never re-enter card details.", "Track AOV weekly — this flow should lift it 25–60%."]
    }),

    "Build Funnel": (ctx, t, r) => ({
      artifactLabel: "Funnel blueprint",
      artifact: [
        `GOAL: ${ctx.outcome || "booked calls"} for ${ctx.topic}`,
        ``,
        `STAGE 1 — TRAFFIC: 3 content pillars + 1 ${pick(r, ["lead magnet", "free tool", "mini-course"])}.`,
        `STAGE 2 — CAPTURE: one-field opt-in. Headline: "${pick(r, t.hooks)} ${pick(r, D.BENEFITS)}".`,
        `STAGE 3 — NURTURE: 5-email arc (story → proof → mechanism → objection → offer).`,
        `STAGE 4 — CONVERT: offer page with a single CTA: ${ctx.cta}`,
        `STAGE 5 — ASCEND: post-purchase upsell + referral loop.`,
        ``,
        `KPIs: opt-in ≥ 30% · email CTR ≥ 4% · page conversion ≥ 3%.`
      ].join("\n"),
      plan: ["Build capture page first — traffic without capture is charity.", "Ship ugly v1 in 48h; optimize only after 200 visits.", `${flipFor(ctx, r)}`]
    }),

    "Landing Page Copy": (ctx, t, r) => ({
      artifactLabel: "Landing page copy",
      artifact: [
        `H1: ${pick(r, t.hooks)} ${ctx.outcome || pick(r, D.BENEFITS)}.`,
        `SUB: For ${ctx.niche || "operators"} who want ${ctx.topic} without the guesswork.`,
        ``,
        `SECTION 1 — PAIN: name the grind. Three bullets, their words.`,
        `SECTION 2 — MECHANISM: the one-system answer. "${pick(r, t.bridges)} ${pick(r, D.BENEFITS)}."`,
        `SECTION 3 — PROOF: ${pick(r, D.PROOFS)}.`,
        `SECTION 4 — OFFER + GUARANTEE.`,
        `SECTION 5 — FAQ: lead with "${ctx.objection || "is this for me?"}"`,
        ``,
        `CTA (repeated 3x): ${ctx.cta}`
      ].join("\n"),
      plan: ["One page, one goal, one CTA.", "Above the fold must answer: what, for whom, why now.", "Swap H1 weekly until bounce < 55%."]
    }),

    "Lead Magnet Idea": (ctx, t, r) => ({
      artifactLabel: "Lead magnet concept",
      artifact: [
        `TITLE: "The ${ctx.topic} Cheat-Sheet: ${pick(r, ["7 plays", "the 15-minute setup", "steal these scripts"])}"`,
        ``,
        `FORMAT: 1-page PDF + 5-minute Loom walkthrough.`,
        `PROMISE: one quick win in under 15 minutes — a taste of ${ctx.outcome || pick(r, D.BENEFITS)}.`,
        `BRIDGE: last page pitches the core offer: ${ctx.cta}`,
        ``,
        `DISTRIBUTION: pinned post + auto-DM keyword "${(ctx.topic.split(" ")[0] || "SYSTEM").toUpperCase()}".`
      ].join("\n"),
      plan: ["Deliver instantly via auto-DM to harvest the keyword trigger.", "Gate with email only — no phone field, it halves opt-ins.", "Follow with the 5-email nurture arc within the hour."]
    }),

    "Market Narrative Scan": (ctx, t, r) => ({
      artifactLabel: "Narrative scan",
      artifact: [
        `FOCUS: ${ctx.topic}`,
        ``,
        `NARRATIVE HEAT: map mentions across CT, Discord alpha groups, and dev activity.`,
        `SIGNALS TO LOG: new listings chatter · unlock schedules · whale wallet clustering.`,
        `THESIS DRAFT: "${pick(r, t.bridges)} attention rotates before liquidity — position where the story is going, not where it is."`,
        ``,
        `RISK BOX: position size ≤ 2% per idea · invalidations written BEFORE entry.`,
        ``,
        `⚠ Research notes only — not financial advice. Verify everything on-chain.`
      ].join("\n"),
      plan: ["Track 5 narrative keywords daily; log deltas, not levels.", "Write the invalidation before the entry — always.", "Review the scan every Sunday; kill stale theses without mercy."]
    }),

    "Position Plan": (ctx, t, r) => ({
      artifactLabel: "Position plan",
      artifact: [
        `IDEA: ${ctx.topic}`,
        ``,
        `ENTRY: staggered 3-tranche entry (40/30/30) at pre-set levels.`,
        `INVALIDATION: written thesis-break condition — exit fully, no averaging down.`,
        `TARGETS: take 30% at 2R, trail the rest.`,
        `SIZE: ≤ 2% account risk. ${pick(r, t.closers)}`,
        ``,
        `JOURNAL: log entry reason, emotion (1–5), and outcome for the weekly audit.`,
        ``,
        `⚠ Framework only — not financial advice.`
      ].join("\n"),
      plan: ["Set alerts at all three levels before doing anything else.", "No entries within 30 minutes of major news.", "Grade the process, not the outcome, in Sunday review."]
    }),

    "Weekly Briefing": (ctx, t, r) => ({
      artifactLabel: "Weekly briefing",
      artifact: [
        `WEEKLY BRIEF — ${ctx.topic}`,
        ``,
        `1. WHAT MOVED: top 3 narratives by attention delta.`,
        `2. WHAT DIDN'T: crowded trades losing steam — fade list.`,
        `3. WATCHLIST: 3 setups with written invalidations.`,
        `4. PORTFOLIO NOTE: rebalance drift > 10% back to plan.`,
        ``,
        `${pick(r, t.hooks)} Consistency beats conviction. ${pick(r, t.closers)}`,
        ``,
        `⚠ Not financial advice.`
      ].join("\n"),
      plan: ["Publish the brief same hour every week — the rhythm builds the audience.", "End with one question to drive replies.", "Archive each brief; quarterly, mine them for accuracy stats."]
    }),

    "Recruit Pitch": (ctx, t, r) => ({
      artifactLabel: "Recruit pitch",
      artifact: [
        `TARGET: ${ctx.topic}`,
        ``,
        `OPEN: "Your work on ${ctx.niche || ctx.topic} caught my attention — specifically ${pick(r, ["the way you ship", "your consistency", "the quality bar you hold"])}."`,
        ``,
        `PITCH: "I'm building ${ctx.outcome || "a lean team that owns outcomes"}. ${pick(r, t.bridges)} ${pick(r, D.BENEFITS)}."`,
        ``,
        `ASK: "${ctx.cta}"`,
        ``,
        `IF HESITANT: "${flipFor(ctx, r)}"`
      ].join("\n"),
      plan: ["Personalize the first line or don't send it.", "Sell the mission and the growth curve, not just the money.", "Move to a 15-minute call within two messages."]
    }),

    "Outreach Sequence": (ctx, t, r) => ({
      artifactLabel: "Outreach sequence (4 touches)",
      artifact: [
        `TOUCH 1 — compliment + specific observation about ${ctx.topic}. No ask.`,
        `TOUCH 2 (+3d) — share a resource relevant to their work. Still no ask.`,
        `TOUCH 3 (+5d) — "${pick(r, t.bridges)} I'm looking for ${ctx.outcome || "one great person"} — you came to mind first." Soft ask.`,
        `TOUCH 4 (+7d) — "${pick(r, t.closers)} ${ctx.cta}"`,
        ``,
        `RULE: value twice before asking once.`
      ].join("\n"),
      plan: ["Batch 20 prospects per week; quality beats volume.", "Track reply rate per touch; kill any touch under 5%.", "Warm candidates who decline — circumstances change quarterly."]
    }),

    "Screening Script": (ctx, t, r) => ({
      artifactLabel: "Screening script",
      artifact: [
        `ROLE: ${ctx.topic}`,
        ``,
        `Q1. "Walk me through something you shipped end-to-end. What broke?"`,
        `Q2. "What would you do in week one here, unprompted?"`,
        `Q3. "Describe a time you disagreed with a decision. What did you do?"`,
        `Q4. Scenario: "${ctx.objection || "A launch slips 2 days before deadline"}" — score their FIRST instinct.`,
        ``,
        `SCORE: ownership (1–5) · speed (1–5) · communication (1–5). Hire ≥ 12 only.`,
        `${pick(r, t.closers)}`
      ].join("\n"),
      plan: ["Same questions for every candidate — comparability is the point.", "Score within 10 minutes of the call while it's fresh.", "Reference-check the best answer, not the resume."]
    })
  };

  /* inheritsLayer — does this clone take the given GOD CORE DNA layer?
     A clone forged before the Forge grew per-layer toggles has dnaLayers null,
     which means every layer, so old clones keep generating exactly as before.
     The Decision Framework is deliberately not consulted here: it binds every
     intelligence and is applied further down, outside the learning-source
     branch. */
  function inheritsLayer(clone, key) {
    if (clone.learningSource !== "Use GOD CORE DNA") return false;
    if (!Array.isArray(clone.dnaLayers)) return true;
    return clone.dnaLayers.indexOf(key) !== -1;
  }

  /* ---------------- public: local generation ---------------- */
  function generateLocal(clone, task, dna) {
    const tone = D.TONES[clone.tone] || D.TONES["Direct"];
    const seed = hashStr([clone.id, task.type, task.topic, task.outcome, Date.now() >> 12].join("|"));
    const r = rng(seed);

    const usesCTA = dna && dna.cta && inheritsLayer(clone, "cta");
    const cta = usesCTA && r() < 0.6 ? dna.cta : pick(r, tone.ctas);

    const ctx = {
      topic: task.topic || "your offer",
      outcome: task.outcome || "",
      objection: task.objection || "",
      niche: task.niche || "",
      urgency: task.urgency || "",
      cta,
      cloneName: clone.name
    };

    const gen = GEN[task.type] || GEN["Write Tweet"];
    const out = gen(ctx, tone, r);

    const notes = ctxLines(ctx);
    /* Phase Delta: surface which vault knowledge informed this artifact */
    if (task.knowledge && task.knowledge.length) {
      notes.push(`Vault knowledge applied: ${task.knowledge.map(k => k.title).join(" · ").slice(0, 140)}`);
    }
    /* Phase Epsilon: collaboration chain acknowledgment */
    if (task.chain && task.chain.length) {
      notes.push(`Collaboration chain: built on ${task.chain.length} upstream output(s) — ${task.chain.map(x => x.from).join(", ").slice(0, 100)}`);
    }
    /* Decision Framework binds every clone, whatever its learning source */
    if (dna && dna.decision) notes.push(`Decision framework honored: ${firstLine(dna.decision)}`);
    if (dna && dna.mindset && inheritsLayer(clone, "mindset")) notes.push(`GOD CORE DNA applied: ${firstLine(dna.mindset)}`);
    if (clone.learningSource === "Train on Past Performance" && clone.memory.length) {
      notes.push(`Applied lesson: ${clone.memory[clone.memory.length - 1]}`);
    }
    if (clone.mindset) notes.push(`Mindset rule honored: ${firstLine(clone.mindset)}`);

    return {
      engine: "local",
      artifactLabel: out.artifactLabel,
      artifact: out.artifact,
      plan: out.plan,
      cta,
      notes,
      text: renderText(clone, task, out, cta, notes)
    };
  }

  function firstLine(s) { return String(s).split("\n")[0].slice(0, 120); }

  function renderText(clone, task, out, cta, notes) {
    return [
      `▸ ${out.artifactLabel.toUpperCase()} — ${task.topic}`,
      ``,
      out.artifact,
      ``,
      `── EXECUTION PLAN ──`,
      ...out.plan.map((p, i) => `${i + 1}. ${p}`),
      ``,
      `CTA: ${cta}`,
      ...(notes.length ? [``, `── CLONE NOTES ──`, ...notes.map(n => `• ${n}`)] : [])
    ].join("\n");
  }

  /* ---------------- Neural Link: Claude API ---------------- */
  const API_URL = "https://api.anthropic.com/v1/messages";
  const MODELS = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"];

  function systemPrompt(clone, dna) {
    const tone = D.TONES[clone.tone];
    const lines = [
      `You are ${clone.name}, a specialized AI clone inside PRISM-X, the user's personal multi-agent business system.`,
      `Role: ${clone.role} — ${D.ROLES[clone.role] ? D.ROLES[clone.role].blurb : ""}`,
      `Voice/tone: ${clone.tone}. ${tone ? tone.desc : ""}`,
      clone.target ? `Your standing target: ${clone.target}.` : "",
      clone.mindset ? `Mindset rules you must follow:\n${clone.mindset}` : "",
      clone.skills ? `Skill/tool focus: ${clone.skills}.` : ""
    ];
    if (clone.learningSource === "Use GOD CORE DNA" && dna) {
      /* Only the layers this clone was forged to inherit. The Forge shows the
         operator exactly this list, so what the prompt carries and what the
         DNA panel claims cannot drift apart. */
      const inherited = [];
      if (dna.tone   && inheritsLayer(clone, "tone"))   inherited.push(`- Operator voice: ${dna.tone}`);
      if (dna.mindset && inheritsLayer(clone, "mindset")) inherited.push(`- Operator mindset: ${dna.mindset}`);
      if (dna.logic  && inheritsLayer(clone, "logic"))  inherited.push(`- Operator strategy: ${dna.logic}`);
      if (dna.cta    && inheritsLayer(clone, "cta"))    inherited.push(`- Signature CTA to prefer: ${dna.cta}`);
      if (inherited.length) {
        lines.push(`GOD CORE DNA (inherit this from the operator):`);
        inherited.forEach(l => lines.push(l));
      }
    }
    if (clone.learningSource === "Train on Past Performance" && clone.memory.length) {
      lines.push(`Lessons learned from past performance (apply them):`);
      clone.memory.slice(-5).forEach(m => lines.push(`- ${m}`));
    }
    /* The Decision Framework is inherited by EVERY PRISM-X intelligence,
       independent of learning source, unless explicitly overridden. */
    if (dna && dna.decision) {
      lines.push(
        `Decision Framework — non-negotiable operating laws for every PRISM-X intelligence. Weigh every decision against these BEFORE executing; they take precedence over convenience and may only be overridden by an explicit operator instruction:`,
        dna.decision
      );
    }
    lines.push(
      `Output format (plain text, no markdown headings):`,
      `1) The finished artifact first, ready to copy-paste.`,
      `2) A line "── EXECUTION PLAN ──" followed by 3-5 numbered steps.`,
      `3) A final line starting exactly with "CTA: " containing the single call-to-action used.`
    );
    return lines.filter(Boolean).join("\n");
  }

  function taskPrompt(task) {
    const parts = [
      `Task type: ${task.type}`,
      `Topic / product / goal: ${task.topic}`,
      task.outcome ? `Target outcome: ${task.outcome}` : "",
      task.objection ? `Audience objection to pre-handle: ${task.objection}` : "",
      task.niche ? `Niche: ${task.niche}` : "",
      task.urgency ? `Time urgency: ${task.urgency}` : ""
    ];
    /* Phase Delta: relevant vault knowledge rides into the prompt */
    if (task.knowledge && task.knowledge.length) {
      parts.push(`Relevant knowledge retrieved from the vault (apply where useful):`);
      task.knowledge.forEach(k => parts.push(`- [${k.category} · confidence ${k.confidence}/100] ${k.title}: ${k.excerpt}`));
    }
    /* Phase Epsilon: structured context handed down the collaboration chain */
    if (task.chain && task.chain.length) {
      parts.push(`Structured context from collaborating workers upstream (build directly on it):`);
      task.chain.forEach(x => parts.push(`- ${x.from} · ${x.step}: ${x.excerpt}`));
    }
    parts.push(`Produce the artifact and plan now.`);
    return parts.filter(Boolean).join("\n");
  }

  /* Low-level Neural Link call — shared by clone tasks and Product Ghosts.
   * PHASE H0: delegates to the Provider Manager, so no module talks to an
   * AI model directly. The manager calls back with __direct set. */
  async function complete(system, prompt, settings, meta) {
    if (window.PRISM && PRISM.providers && !(settings && settings.__direct)) {
      return PRISM.providers.complete(system, prompt, settings, meta);
    }
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        /* Required opt-in for direct browser (CORS) access to the API.
           Only safe here because this is a personal-use app and the key
           never leaves this browser's localStorage. */
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: settings.model || MODELS[0],
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try { const e = await res.json(); if (e && e.error && e.error.message) msg = e.error.message; } catch (_) {}
      throw new Error(msg);
    }
    const data = await res.json();
    if (data.stop_reason === "refusal") throw new Error("The model declined this request.");

    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    if (!text) throw new Error("Empty response from the API.");
    return text;
  }

  /* Phase Alpha: the AI Router decides which model a task category uses. */
  function routedSettings(settings, category) {
    if (!window.PRISM || !PRISM.bridge) return settings;
    try {
      const route = PRISM.bridge.routeFor(category);
      if (route && route.model && route.model !== settings.model) {
        return Object.assign({}, settings, { model: route.model, routedVia: route.provider });
      }
    } catch (_) {}
    return settings;
  }

  /* Which AI Router category a task type belongs to. */
  function categoryFor(taskType) {
    return /tweet|thread|caption|email|copy|content|dm/i.test(taskType) ? "Copywriting / content"
      : /offer|price|funnel|upsell/i.test(taskType) ? "Reasoning / strategy"
      : /market|position|brief/i.test(taskType) ? "Research"
      : "Copywriting / content";
  }

  async function generateNeural(clone, task, dna, settings) {
    const text = await complete(systemPrompt(clone, dna), taskPrompt(task), settings,
      { workerId: clone.id, workerName: clone.name, provider: clone.provider || "auto", category: categoryFor(task.type) });
    const ctaMatch = text.match(/^CTA:\s*(.+)$/m);
    return {
      engine: "neural",
      artifactLabel: task.type,
      artifact: text,
      plan: [],
      cta: ctaMatch ? ctaMatch[1].trim() : "",
      notes: [`Generated via Neural Link (${settings.model || MODELS[0]})`],
      text
    };
  }

  /* Unified entry point. PHASE H0: the Provider Manager decides which
   * provider executes (per-worker Intelligence Provider field, Auto = the
   * AI Router); unavailable providers fail over to the Local Cortex. */
  async function generate(clone, task, dna, settings) {
    /* Phase Delta: every worker retrieves context before executing */
    if (!task.knowledge && window.PRISM && PRISM.knowledge) {
      try { task.knowledge = PRISM.knowledge.retrieve(`${task.topic || ""} ${task.type}`, 2, clone.name); } catch (_) { task.knowledge = []; }
    }
    const category = categoryFor(task.type);
    const P = window.PRISM && PRISM.providers ? PRISM.providers : null;
    const sel = P ? P.resolve(clone.provider || "auto", category)
      : { id: (settings && settings.engine === "neural" && settings.apiKey) ? "claude" : "local", requested: "auto", switched: false };
    if (sel.id === "claude") {
      try {
        return await generateNeural(clone, task, dna, routedSettings(settings, category));
      } catch (err) {
        const local = generateLocal(clone, task, dna);
        local.notes.unshift(`Neural Link unavailable (${err.message}) — Local Cortex answered instead.`);
        local.text = renderText(clone, task, local, local.cta, local.notes);
        local.fallback = true;
        if (P) P.recordLocal({ workerId: clone.id, workerName: clone.name, chars: local.text.length });
        return local;
      }
    }
    const local = generateLocal(clone, task, dna);
    if (sel.switched) {
      local.notes.unshift(`Provider "${P.name(sel.requested)}" unavailable (${sel.reason}) — Local Cortex executed instead.`);
      local.text = renderText(clone, task, local, local.cta, local.notes);
      local.fallback = true;
    }
    if (P) P.recordLocal({
      workerId: clone.id, workerName: clone.name,
      requested: sel.requested, switched: sel.switched, reason: sel.reason,
      chars: local.text.length
    });
    return local;
  }

  /* ---------------- performance simulation ---------------- */
  function dateKey(d) {
    const x = d instanceof Date ? d : new Date(d);
    return x.toISOString().slice(0, 10);
  }

  function recordOutcome(clone, task, rating, when) {
    const role = D.ROLES[clone.role] || { earnFactor: 0.7, leadFactor: 0.8 };
    const r = rng(hashStr(task.id + ":" + rating));
    const leads = Math.max(0, Math.round((1 + r() * 3 + rating) * role.leadFactor));
    let earnings = 0;
    if (rating >= 3) earnings = Math.round((rating - 2) * (35 + r() * 70) * role.earnFactor);

    const key = dateKey(when || Date.now());
    clone.daily = clone.daily || {};
    const day = clone.daily[key] = clone.daily[key] || { earnings: 0, leads: 0, tasks: 0 };
    day.earnings += earnings; day.leads += leads; day.tasks += 1;

    clone.stats.earnings += earnings;
    clone.stats.leads += leads;
    clone.stats.tasks += 1;
    clone.stats.ratingSum += rating;
    clone.stats.ratingCount += 1;
    clone.lastTaskAt = (when || Date.now());

    /* trim daily history to 30 days */
    const keys = Object.keys(clone.daily).sort();
    while (keys.length > 30) delete clone.daily[keys.shift()];

    return { earnings, leads };
  }

  function weeklySeries(daily, days) {
    days = days || 7;
    const out = { labels: [], earnings: [], leads: [], tasks: [] };
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = dateKey(d);
      const rec = (daily && daily[key]) || { earnings: 0, leads: 0, tasks: 0 };
      out.labels.push(d.toLocaleDateString(undefined, { weekday: "short" }));
      out.earnings.push(rec.earnings);
      out.leads.push(rec.leads);
      out.tasks.push(rec.tasks);
    }
    return out;
  }

  function combinedWeekly(clones) {
    const agg = { labels: [], earnings: [], leads: [], tasks: [] };
    clones.forEach((c, idx) => {
      const s = weeklySeries(c.daily);
      if (idx === 0) { agg.labels = s.labels; agg.earnings = s.earnings.slice(); agg.leads = s.leads.slice(); agg.tasks = s.tasks.slice(); }
      else s.earnings.forEach((v, i) => { agg.earnings[i] += v; agg.leads[i] += s.leads[i]; agg.tasks[i] += s.tasks[i]; });
    });
    if (!clones.length) {
      const s = weeklySeries({});
      agg.labels = s.labels; agg.earnings = s.earnings; agg.leads = s.leads; agg.tasks = s.tasks;
    }
    return agg;
  }

  /* ---------------- status derivation ---------------- */
  function effectiveStatus(clone) {
    const now = Date.now();
    if (clone.learnUntil && clone.learnUntil > now) return "learning";
    const recent = recentRatings(clone, 3);
    if (recent.length >= 3 && avg(recent) <= 2) return "needs_update";
    if (clone.lastTaskAt && now - clone.lastTaskAt > 7 * 86400000) return "dormant";
    if (!clone.lastTaskAt && now - clone.createdAt > 7 * 86400000) return "dormant";
    return "active";
  }
  function recentRatings(clone, n) { return (clone.ratingLog || []).slice(-n); }
  function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

  /* ---------------- weekly audit ---------------- */
  function runAudit(state) {
    const clones = state.clones;
    const rated = state.tasks.filter(t => t.rating > 0);
    if (!clones.length || rated.length < 2) {
      return { ok: false, reason: "Not enough performance data yet. Run and rate a few tasks first." };
    }

    /* best clone by earnings */
    const best = clones.slice().sort((a, b) => b.stats.earnings - a.stats.earnings)[0];

    /* best tone by average rating */
    const toneScores = {};
    rated.forEach(t => {
      const c = clones.find(x => x.id === t.cloneId);
      if (!c) return;
      (toneScores[c.tone] = toneScores[c.tone] || []).push(t.rating);
    });
    let bestTone = null, bestToneAvg = 0;
    Object.entries(toneScores).forEach(([tone, arr]) => {
      const a = avg(arr);
      if (a > bestToneAvg) { bestToneAvg = a; bestTone = tone; }
    });

    /* best logic: highest-rated task that carries a CTA */
    const withCta = rated.filter(t => t.cta).sort((a, b) => b.rating - a.rating || b.createdAt - a.createdAt);
    const star = withCta[0] || rated.sort((a, b) => b.rating - a.rating)[0];
    const overallAvg = avg(rated.map(t => t.rating));
    const uplift = overallAvg > 0 ? Math.max(5, Math.round(((star.rating - overallAvg) / overallAvg) * 100)) : 0;

    const report = {
      at: Date.now(),
      bestClone: best ? { id: best.id, name: best.name, earnings: best.stats.earnings } : null,
      bestTone: bestTone ? { tone: bestTone, avg: +bestToneAvg.toFixed(1) } : null,
      bestLogic: star ? { taskType: star.type, topic: star.topic, cta: star.cta || "", rating: star.rating, cloneId: star.cloneId } : null,
      tasksAudited: rated.length
    };

    const upgrade = star && star.cta ? {
      id: "upg_" + Date.now().toString(36),
      headline: `This CTA converted ${uplift}% above network average`,
      detail: `"${star.cta}" — from a ${star.type} rated ${star.rating}/5. Recommend pushing it as the default CTA for all clones.`,
      cta: star.cta,
      uplift,
      kind: "cta"
    } : (bestTone ? {
      id: "upg_" + Date.now().toString(36),
      headline: `"${bestTone}" tone is outperforming (avg ${bestToneAvg.toFixed(1)}/5)`,
      detail: `Recommend all clones weight their voice toward ${bestTone} phrasing this week.`,
      cta: "",
      uplift: Math.round(bestToneAvg * 10),
      kind: "tone"
    } : null);

    return { ok: true, report, upgrade };
  }

  function applyUpgrade(state, upgrade) {
    state.godBrainVersion += 1;
    const v = state.godBrainVersion;
    const memo = upgrade.kind === "cta"
      ? `Brain v${v}: default CTA updated → "${upgrade.cta}"`
      : `Brain v${v}: ${upgrade.headline}`;
    if (upgrade.kind === "cta" && state.dna) state.dna.cta = upgrade.cta;
    state.clones.forEach(c => {
      c.brainVersion = v;
      c.memory.push(memo);
      c.learnUntil = Date.now() + 45000; /* brief LEARNING window for the glow */
    });
    return memo;
  }

  return {
    MODELS, generate, generateLocal, generateNeural, systemPrompt, complete, categoryFor,
    inheritsLayer, recordOutcome, weeklySeries, combinedWeekly,
    effectiveStatus, runAudit, applyUpgrade, dateKey, rng, hashStr
  };
})();
