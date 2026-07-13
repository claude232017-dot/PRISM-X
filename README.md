# ◈ PRISM-X — GOD CORE

**A personal multi-agent digital intelligence system.** Each clone is a specialized
piece of your brain — closing DMs, writing copy, building offers, scanning markets —
all commanded, audited and evolved by a central brain called **GOD CORE**.

No backend. No accounts. No build step. Everything lives in your browser.

---

## Quick start

```bash
# any static server works
npx serve .          # or: python3 -m http.server 8000
```

Open the URL, and PRISM-X boots into the **onboarding sequence**: you train GOD CORE
once with your tone, mindset, strategy and signature CTA — every clone you forge
inherits that DNA. Opening `index.html` directly from disk also works.

## The system

| Module | What it does |
|---|---|
| **GOD CORE dashboard** | KPI tiles (earnings · leads · tasks · active clones), 7-day network output chart, the clone grid with live status badges (ACTIVE / LEARNING / DORMANT / NEEDS UPDATE), and command buttons: Clone New Agent, Replicate Top Performer, Push Brain Update to All Clones, Run Weekly Audit. |
| **Clone Forge** | Deploy a clone from a template: name, role (DM Closer, Copywriter, Funnel Builder, Offer Generator, Crypto Strategist, Recruiter), target output, tone (Direct, Persuasive, Calm Alpha, Entertainer), mindset rules, skill/tool focus, and learning source (GOD CORE DNA or past performance). |
| **Task console** | Give any clone a mission: task type, topic/product/goal, target outcome, plus optional objection / niche / urgency targeting. It returns the finished artifact + an execution plan + a CTA. Rate it 1–5 ★, toggle **Learn from This** (commits to the clone's memory), **Send to GOD CORE** (broadcasts the logic to every clone), or **Repeat Weekly** (auto re-runs every 7 days). Clones can **collaborate** — e.g. your Copywriter drafts, your DM Closer executes. |
| **Evolve system** | The weekly audit analyzes every rated task, surfaces your best clone / tone / logic, and proposes system-wide upgrades ("This CTA converted 38% above network average — push it to all clones?"). Confirm & Push bumps the network brain version, and every clone visibly enters a LEARNING state. Every change is logged in **System Memory**. |
| **Clone Vaults** | Everything a clone produces is archived by category — Content, Offers, Sales Data, Objection Scripts, Lessons Learned — and exportable: copy as Markdown (paste into Notion), local PDF, email, or post straight to X. |
| **Broadcast Queue** | Schedule any task output or vault item for X: pick a fire time, and due posts surface with a badge, dashboard banner and toast. One click opens the pre-filled X composer and marks the item posted. (The app is serverless by design — nothing ever posts without you.) |

## Generation engines

- **Local Cortex** (default) — an offline combinatorial template engine. Instant,
  free, private. Every role and task type produces a structured artifact + plan.
- **Neural Link** — plug in your own Anthropic API key (Settings → Generation engine)
  and each clone becomes a real AI agent: its role, tone, mindset rules and GOD CORE
  DNA are compiled into a Claude system prompt. Models: `claude-opus-4-8`
  (recommended), `claude-sonnet-5`, `claude-haiku-4-5`. If a call fails, the Local
  Cortex answers instead so you're never blocked.

> **Key safety:** the API key is stored only in your browser's localStorage and sent
> only to `api.anthropic.com`. This is fine for a personal machine — don't use
> Neural Link on a shared computer.

## Data

- Backup / restore your whole system as JSON (Settings → Data).
- A demo squadron (APEX · QUILL · VULCAN) with sample history can be deployed
  during onboarding or from Settings — delete them anytime.
- Simulated performance: rating a task attributes leads/earnings to the clone based
  on its role economics, which feeds the dashboards and the weekly audit.

## Bundled Claude Code skills

`.claude/skills/` ships with installed skill packs for working on this repo with
Claude Code: `karpathy-guidelines` (multica-ai), the `ui-ux-pro-max` suite
(nextlevelbuilder), and seven curated skills from `affaan-m/ECC` — the full
197-skill ECC collection is vendored in `.claude/skills-library/ecc/` (see the
README there for how to activate more).

## Stack

Vanilla HTML/CSS/JS — zero dependencies. `js/data.js` (roles, tones, templates),
`js/engine.js` (generation + audit + simulation), `js/store.js` (state +
persistence), `js/ui.js` (components, charts, sound FX), `js/app.js` (views).
