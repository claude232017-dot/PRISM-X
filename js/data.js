/* PRISM-X — data.js
 * Static definitions: roles, tones, task types, and the template library
 * that powers the local (offline) generation cortex.
 */
window.PRISM = window.PRISM || {};

PRISM.data = (function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * TONES — each tone shapes hooks, connectors, closers and CTAs,
   * and carries a style descriptor used by the Neural Link system prompt.
   * ------------------------------------------------------------------ */
  const TONES = {
    "Direct": {
      desc: "Short, blunt, zero fluff. Commands, not suggestions. One idea per line.",
      hooks: ["Stop scrolling.", "Read this twice.", "No fluff:", "Here's the play:", "Straight up:", "You're overcomplicating it."],
      bridges: ["Here's why:", "The math is simple:", "Look:", "Bottom line:", "Translation:"],
      closers: ["Move.", "Your call. Clock's ticking.", "Do it today, not Monday.", "That's the whole game.", "Execute."],
      ctas: ["Reply 'IN' and I'll send the link.", "DM me 'GO' to start today.", "Grab your spot before midnight.", "Book the call. Now."]
    },
    "Persuasive": {
      desc: "Warm, benefit-led, objection-aware. Builds a yes-ladder before the ask.",
      hooks: ["Imagine waking up to this:", "Quick question —", "Most people never realize this:", "What if the only thing missing was one system?", "Here's what changed everything for my clients:"],
      bridges: ["And here's the best part:", "Which means:", "That's exactly why:", "Picture this:", "So what does that mean for you?"],
      closers: ["You've got nothing to lose and a whole pipeline to gain.", "The only bad decision is no decision.", "You already know the answer.", "Let's make this your turning point."],
      ctas: ["Want me to send the details? Just say 'yes'.", "Tap the link and see it for yourself.", "Reply 'INFO' — no pressure, just proof.", "Save your seat while they last."]
    },
    "Calm Alpha": {
      desc: "Low word count, high certainty. Never chases. States facts, sets frames, walks away rich.",
      hooks: ["Some numbers don't need hype.", "I don't chase. I attract.", "Quiet observation:", "While they argue, we build.", "Standards first."],
      bridges: ["Consider:", "The frame is simple:", "It compounds:", "Noted:", "Meanwhile:"],
      closers: ["Take it or leave it.", "The door closes either way.", "We move regardless.", "Discipline decides."],
      ctas: ["If you're serious, you know where to find me.", "One spot. One decision. DM 'READY'.", "Apply if it fits. Skip if it doesn't.", "The link is below. No countdown timers."]
    },
    "Entertainer": {
      desc: "High-energy, meme-aware, playful hooks with a sharp point underneath. Jokes land, then the pitch lands.",
      hooks: ["POV: your pipeline actually fills itself 😳", "Nobody: … Me at 3am building funnels:", "Breaking news from the trenches:", "Plot twist —", "This is your sign (yes, THAT sign):"],
      bridges: ["And then it got weirder (better):", "Meanwhile in results-land:", "Cue the montage:", "Here's the punchline:", "But wait, there's actual substance:"],
      closers: ["Okay okay, jokes aside — this works.", "Laugh now, screenshot later.", "Future you says thanks in advance.", "Roll credits. Then roll profits."],
      ctas: ["Smash reply with '🚀' and I'll send it over.", "Link in bio (it bites, in a good way).", "DM 'MEME' for the not-a-joke offer.", "Tag a friend who needs this (it's you, you're the friend)."]
    }
  };

  /* ------------------------------------------------------------------ *
   * ROLES — each role defines its task types and an economics profile
   * used by the performance simulator.
   * ------------------------------------------------------------------ */
  const ROLES = {
    "DM Closer": {
      icon: "◈",
      blurb: "Turns conversations into closed deals.",
      taskTypes: ["Close DM", "Opening DM", "DM Follow-Up", "Objection Handler"],
      earnFactor: 1.0, leadFactor: 0.8
    },
    "Copywriter": {
      icon: "✎",
      blurb: "Writes hooks, threads and copy that pull leads in.",
      taskTypes: ["Write Tweet", "Write Thread", "Write Caption", "Email Copy"],
      earnFactor: 0.4, leadFactor: 1.4
    },
    "Funnel Builder": {
      icon: "▼",
      blurb: "Designs pages and paths that convert traffic to buyers.",
      taskTypes: ["Build Funnel", "Landing Page Copy", "Lead Magnet Idea"],
      earnFactor: 0.9, leadFactor: 1.1
    },
    "Offer Generator": {
      icon: "◆",
      blurb: "Packages skills into irresistible, priced offers.",
      taskTypes: ["Build Offer", "Price & Package", "Design Upsell"],
      earnFactor: 1.2, leadFactor: 0.6
    },
    "Crypto Strategist": {
      icon: "Ξ",
      blurb: "Scans narratives and drafts market playbooks.",
      taskTypes: ["Market Narrative Scan", "Position Plan", "Weekly Briefing"],
      earnFactor: 1.1, leadFactor: 0.5
    },
    "Recruiter": {
      icon: "⌖",
      blurb: "Sources, pitches and screens talent or partners.",
      taskTypes: ["Recruit Pitch", "Outreach Sequence", "Screening Script"],
      earnFactor: 0.5, leadFactor: 1.2
    }
  };

  const LEARNING_SOURCES = ["Use GOD CORE DNA", "Train on Past Performance"];

  const STATUS_META = {
    active:       { label: "ACTIVE",       cls: "st-active" },
    learning:     { label: "LEARNING",     cls: "st-learning" },
    dormant:      { label: "DORMANT",      cls: "st-dormant" },
    needs_update: { label: "NEEDS UPDATE", cls: "st-needs" }
  };

  /* Vault categories */
  const VAULT_TYPES = {
    content:   "Content",
    offer:     "Offers",
    sales:     "Sales Data",
    objection: "Objection Scripts",
    lesson:    "Lessons Learned"
  };

  /* Which vault category each task type's artifact lands in */
  const TASK_VAULT = {
    "Close DM": "sales", "Opening DM": "content", "DM Follow-Up": "content", "Objection Handler": "objection",
    "Write Tweet": "content", "Write Thread": "content", "Write Caption": "content", "Email Copy": "content",
    "Build Funnel": "offer", "Landing Page Copy": "content", "Lead Magnet Idea": "offer",
    "Build Offer": "offer", "Price & Package": "offer", "Design Upsell": "offer",
    "Market Narrative Scan": "content", "Position Plan": "sales", "Weekly Briefing": "content",
    "Recruit Pitch": "content", "Outreach Sequence": "content", "Screening Script": "objection"
  };

  /* ------------------------------------------------------------------ *
   * TEMPLATE FRAGMENTS shared by generators
   * ------------------------------------------------------------------ */
  const BENEFITS = [
    "more qualified leads without more hours",
    "a pipeline that works while you sleep",
    "buyers who show up pre-sold",
    "compounding attention that turns into cash",
    "a system, not a hustle",
    "predictable revenue instead of random spikes"
  ];
  const PROOFS = [
    "took one client from 0 → 40 booked calls in 30 days",
    "3x'd reply rates by changing a single opening line",
    "turned a dead list into $4k in a weekend",
    "grew an account 12k followers with 6 posts",
    "cut cost-per-lead by 61% with one page rewrite"
  ];
  const OBJECTION_FLIPS = [
    ["it's too expensive", "Compare it to the cost of another 6 months of guessing. The offer pays for itself at one client."],
    ["I don't have time", "That's exactly why this exists — it's built for people with no time. Setup is 20 minutes, then it runs."],
    ["I need to think about it", "Totally fair. What specifically do you want to be sure about? Let's solve that in 2 minutes instead of 2 weeks."],
    ["I've tried things like this before", "Then you already know what doesn't work — which means you'll recognize immediately why this is different."],
    ["I'm not sure it works for my niche", "The mechanism is niche-agnostic; the messaging is custom. That's the part we build for you."]
  ];
  const URGENCY_LINES = {
    high:   "Deadline framing: doors close / price rises — say it once, mean it.",
    medium: "Soft scarcity: limited weekly capacity, first-come priority.",
    low:    "Evergreen framing: no fake timers — lead with proof and fit."
  };

  return { TONES, ROLES, LEARNING_SOURCES, STATUS_META, VAULT_TYPES, TASK_VAULT, BENEFITS, PROOFS, OBJECTION_FLIPS, URGENCY_LINES };
})();
