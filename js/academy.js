/* PRISM-X — academy.js
 * PHASE Ω-1 — PRISM-X ACADEMY.
 *
 * An in-app learning + documentation system. Every major module gets a
 * structured lesson (What / Why / Why-built / How / Quick Start / Sandbox /
 * Best Practices / Common Mistakes / Related / Advanced / Testing Checklist /
 * Future), a global "how do I…" search, and context-aware help reachable from
 * any page. Content is authored data — no backend, no network. Checklist
 * progress is the only piece of persisted state.
 */
window.PRISM = window.PRISM || {};

PRISM.academy = (function () {
  "use strict";
  const S = () => PRISM.store;

  /* ------------------------------------------------------------------ *
   * The curriculum — one lesson per module, in build/nav order.
   * key    → matches the router view (context help maps routes → key)
   * route  → where "Try it" sends the user
   * ------------------------------------------------------------------ */
  const ACADEMY = [
    {
      key: "dashboard", icon: "◈", name: "GOD CORE", route: "#/dashboard",
      tagline: "Your command deck and the DNA every agent inherits.",
      whatIs: "The GOD CORE is the home base of PRISM-X. It holds your five-layer DNA (voice, mindset, strategy, decision framework, signature CTA) and shows the live pulse of everything you've deployed — clones, income, tasks and system memory.",
      why: ["See your whole operation at a glance", "Train the DNA once, and every agent inherits it", "Jump to any module from one place"],
      whyBuilt: "Every AI agent you create needs a consistent personality and set of operating rules. Rather than re-teaching each one, the GOD CORE captures that reasoning a single time and injects it everywhere — so scaling to dozens of agents never means dozens of re-briefings.",
      flow: ["Onboard (train 5 DNA layers)", "Deploy demo squadron", "Watch the dashboard pulse", "Open any module"],
      quickStart: ["Click Dashboard in the top nav", "Read the DNA summary cards", "Open Forge Clone to create your first Worker", "Return here — your new clone now shows in the pulse"],
      sandbox: { text: "The onboarding flow deploys a demo squadron (APEX, QUILL, VULCAN) with sample history so the dashboard is populated from minute one — explore it before creating anything of your own." },
      best: ["Invest real thought in the DNA — it compounds across every agent", "Re-visit the dashboard after each work session to catch drift", "Use the demo squadron to learn before deleting it"],
      mistakes: [
        { bad: "Leaving DNA layers blank to 'save time'", good: "Fill all five — vague DNA makes vague agents" },
        { bad: "Deleting the demo squadron before you've explored it", good: "Keep it until you understand each module" }
      ],
      related: ["forge", "missions", "bridge"],
      advanced: ["Re-training DNA bumps the brain version — older agents keep their snapshot until re-briefed", "The engine pill (top-right) shows whether you're on the Local Cortex or a live Neural Link"],
      checklist: ["Complete onboarding", "Read the DNA cards", "Deploy the demo squadron", "Open one module from the nav"]
    },
    {
      key: "forge", icon: "⬡", name: "Clone Forge & Workers", route: "#/forge",
      tagline: "Spin up specialist AI workers and run tasks from their consoles.",
      whatIs: "Clones are your specialist Workers. Each has a role (DM Closer, Copywriter, Offer Generator…), inherits the GOD CORE DNA, and runs tasks from its own console — generating real content you can rate and bank in the vault.",
      why: ["Build a ghostwriting team", "Automate cold-DM closing", "Generate offers and sales copy on demand"],
      whyBuilt: "One general assistant is mediocre at everything. Specialists are excellent at one thing. The Forge exists so you can assemble a team of narrow experts — each tuned to a role — instead of over-loading a single do-everything agent.",
      flow: ["Forge a clone (pick role + tone)", "Open its console", "Run a task", "Rate the output", "It banks to the vault + learns"],
      quickStart: ["Open Forge Clone", "Name it and pick a role", "Encode — the clone appears on your dashboard", "Open its console and run your first task", "Rate the result 1–5★"],
      sandbox: { text: "APEX (DM Closer), QUILL (Copywriter) and VULCAN (Offer Generator) ship pre-loaded with two weeks of sample tasks and ratings — open any console to see how a trained worker behaves." },
      best: ["One clear role per clone", "Rate honestly — ratings drive the learning loop", "Reuse a strong clone across many tasks instead of forging near-duplicates"],
      mistakes: [
        { bad: "Forging a new worker for every small task", good: "Reuse specialized workers — they get better with each rating" },
        { bad: "Never rating outputs", good: "Rate every run so the clone can improve" }
      ],
      related: ["dashboard", "runtime", "queue", "missions"],
      advanced: ["High-performing clones can be replicated to spread proven DNA", "A clone's ratingLog feeds Evolution scorecards and prompt-version performance"],
      checklist: ["Forge a clone", "Open its console", "Run a task", "Rate the output", "Confirm it appears in the vault"]
    },
    {
      key: "queue", icon: "📡", name: "Broadcast Queue", route: "#/queue",
      tagline: "Stage generated content and post it to X on your schedule — you always click send.",
      whatIs: "The Broadcast Queue is a scheduling staging area. Content your agents generate can be queued with a due time; when it's time, PRISM-X pre-fills the X composer for you.",
      why: ["Batch a week of posts in one sitting", "Keep a faceless brand posting daily", "Review before anything goes public"],
      whyBuilt: "Automation that posts on its own is a liability — one bad generation and your brand is damaged in public. The queue keeps a human in the loop by design: it prepares the post, you approve the send.",
      flow: ["Agent generates content", "Queue it with a due time", "Queue reminds you when due", "Composer pre-fills", "You click send"],
      quickStart: ["Generate a post from a clone or shell", "Send it to the Broadcast Queue", "Open Queue and review the schedule", "When due, open X from the item and post"],
      sandbox: { text: "Ghost and Shell launches auto-queue their opening posts — open the Queue after deploying one to see a scheduled item without creating anything manually." },
      best: ["Batch-schedule to keep a steady cadence", "Review copy in the queue before it's due", "Clear stale items so the badge count stays meaningful"],
      mistakes: [
        { bad: "Expecting it to auto-post to X", good: "It never posts for you — you always click send" },
        { bad: "Letting the queue pile up unreviewed", good: "Prune and review regularly" }
      ],
      related: ["forge", "shells", "integrations"],
      advanced: ["The Execution Layer can publish to the queue programmatically via queue.publish (permission-gated)", "The nav badge shows items currently due"],
      checklist: ["Queue a piece of content", "Set a due time", "Open the Queue view", "Post one item to X"]
    },
    {
      key: "ghosts", icon: "👻", name: "Product Ghosts", route: "#/ghosts",
      tagline: "Autonomous product agents that ideate, build and launch digital offers.",
      whatIs: "Product Ghosts are agents that run the full product loop: detect a pain, ideate an offer, build the assets (sales page, DM flow, launch thread) and 'launch' it on a simulated market to track performance.",
      why: ["Test many product ideas cheaply", "Build a portfolio of digital offers", "Learn which niches and angles convert"],
      whyBuilt: "Manually researching, building and launching a product takes weeks. Ghosts compress that loop so you can run many parallel experiments and let the winners reveal themselves before you invest real effort.",
      flow: ["Deploy a Ghost", "It ideates a product", "Builds the assets", "Launches (sim) & tracks", "Hits target → spawns a sub-ghost"],
      quickStart: ["Open Ghosts → Ghost Forge", "Pick a template, niche and target income", "Deploy — it launches a first product", "Fast-forward the sim clock to see results"],
      sandbox: { text: "Deploy a Ghost and advance the sim clock a few days — you'll watch a product move from tracking → hit/relaunch/retired, all on labeled simulation data." },
      best: ["Give each Ghost a distinct niche", "Let underperformers relaunch once before retiring", "Harvest winning angles into your Knowledge vault"],
      mistakes: [
        { bad: "Judging a product before it has tracking days", good: "Let the sim clock run before deciding" },
        { bad: "Cloning the same niche across every Ghost", good: "Diversify niches to find outliers" }
      ],
      related: ["shells", "matrix", "knowledge"],
      advanced: ["Products that beat target auto-spawn a next-generation sub-ghost in a new niche", "Simulated revenue is labeled everywhere and never mixes with the Enterprise ledger"],
      checklist: ["Deploy a Ghost", "Confirm a product launched", "Advance the sim clock", "Review the product's status"]
    },
    {
      key: "shells", icon: "🎭", name: "Outer Shells", route: "#/shells",
      tagline: "Faceless content brands that post daily, grow an audience and capture leads.",
      whatIs: "Outer Shells are faceless brand agents. Each runs a niche persona across platforms, drops content on a daily cadence, grows followers and routes attention toward an offer or an email list.",
      why: ["Run faceless content brands", "Build a distribution audience", "Feed leads into Ghost products"],
      whyBuilt: "Products with no audience die quietly. Shells exist to manufacture the distribution layer — a steady content presence — so the offers your Ghosts build actually reach people.",
      flow: ["Deploy a Shell (niche + persona)", "It drops daily content", "Audience + email list grow", "Attention routes to an offer"],
      quickStart: ["Open Shells → Shell Forge", "Pick a niche, persona and platforms", "Deploy and advance the sim clock", "Watch followers and clicks accrue"],
      sandbox: { text: "Deploy a Shell like NEURALDRIP and run the sim clock — daily posts, follower growth and CTA click-throughs populate the control center automatically." },
      best: ["Test CTA styles — the Shell learns which converts", "Point a Shell at a real Ghost product for a full funnel", "Keep the persona consistent"],
      mistakes: [
        { bad: "Switching persona every day", good: "Consistency compounds audience trust" },
        { bad: "No offer wired to the audience", good: "Route attention to a product or email capture" }
      ],
      related: ["ghosts", "matrix", "queue"],
      advanced: ["Shells wire into SuperFunnels (audience → offer → human closer) in the Matrix", "Content quality rises when a Designer executor delivers visual packs"],
      checklist: ["Deploy a Shell", "Advance the sim clock", "Check follower growth", "Review a generated post"]
    },
    {
      key: "matrix", icon: "◈", name: "Matrix Merge", route: "#/matrix",
      tagline: "Blend AI agents with human freelancers and split every dollar transparently.",
      whatIs: "The Matrix is the human bridge. It onboards freelancers (closers, editors, designers, VAs), generates real task briefs from your agents' assets, tracks delivery, and splits revenue via PayShare — with a live task grid over AI, human and joint work.",
      why: ["Add human closers to AI-run funnels", "Outsource design and editing", "Run a hybrid AI+human agency"],
      whyBuilt: "Some work still needs a human — closing high-ticket DMs, polishing copy, real design. The Matrix exists so humans and agents operate as one workforce, with briefs, delivery and pay-splits handled in one ledger instead of scattered DMs and spreadsheets.",
      flow: ["Onboard an executor", "Assign a task (brief auto-generated)", "Send the brief packet", "They deliver → you score", "Revenue splits via PayShare"],
      quickStart: ["Open Matrix → Auto-Onboard Freelancer", "Set role, permission and PayShare %", "Assign a task from an agent asset", "Copy the brief packet and send it", "Score the delivery when it returns"],
      sandbox: { text: "Onboard an executor and assign a task — the brief is generated from a real agent asset, and delivery, PayShare and the income ledger update as a labeled simulation." },
      best: ["Match role to the work (Closer vs Designer)", "Use SuperFunnels to wire audience → offer → closer", "Score every delivery — it tunes the performer"],
      mistakes: [
        { bad: "Sending vague asks over DM", good: "Use the generated brief packet — it carries context" },
        { bad: "Over-granting permissions", good: "Give least privilege; raise it as trust grows" }
      ],
      related: ["shells", "ghosts", "enterprise"],
      advanced: ["PayShare comes off the top; the remainder splits between vault and reinvest pool", "The reinvest pool can auto-spawn a new Product Ghost"],
      checklist: ["Onboard an executor", "Assign a task", "Open the brief packet", "Score a delivery", "Check the income ledger"]
    },
    {
      key: "bridge", icon: "🌉", name: "PRISM-X Bridge", route: "#/bridge",
      tagline: "The nervous system — every module talks through one set of interfaces.",
      whatIs: "The Bridge is the coordination core. It projects every clone, ghost, shell and human onto one Universal Worker schema, runs the Event Bus, holds shared memory, routes AI requests, and enforces role-based permissions — the single choke point all modules pass through.",
      why: ["See every worker under one schema", "Audit every meaningful action", "Enforce who-can-do-what by role"],
      whyBuilt: "Without a central bus, modules would reach into each other's data and the system would ossify. The Bridge exists so new providers, worker types and integrations plug into stable interfaces — the architecture scales without redesign.",
      flow: ["Module emits an event", "Bridge logs + routes it", "Shared memory / permissions apply", "Command Center + audit trail update"],
      quickStart: ["Open Bridge → Health", "Skim the system status rows", "Open Command Center to watch live events", "Try switching the active role in Permissions"],
      sandbox: { text: "Every action anywhere in PRISM-X flows here — deploy or run anything, then open the Command Center to watch the events stream in real time." },
      best: ["Check Health first when something feels off", "Use roles to gate sensitive resources", "Store durable lessons in Shared Memory, not scattered notes"],
      mistakes: [
        { bad: "Ignoring the audit trail", good: "It's your record of every sensitive action" },
        { bad: "Running everything as Owner", good: "Switch roles to see least-privilege enforcement" }
      ],
      related: ["intelligence", "runtime", "production"],
      advanced: ["The Internal API layer exposes standardized read endpoints for future modules", "The extension bus taps bridge.emit with a single line"],
      checklist: ["Open Bridge Health", "Watch the Command Center", "Inspect a Worker", "Switch the active role"]
    },
    {
      key: "intelligence", icon: "🧠", name: "Intelligence Provider Layer", route: "#/intelligence",
      tagline: "One funnel decides which AI provider answers every request.",
      whatIs: "The Provider Layer is the single funnel for intelligence. Workers never call a model directly — every request routes here and the Provider Manager picks a provider (Claude Neural Link or the offline Local Cortex today; others are provisioned).",
      why: ["Swap AI providers with zero worker changes", "Fail over gracefully when a provider is down", "Keep everything running fully offline"],
      whyBuilt: "Hard-wiring a model into every worker makes the whole system brittle and vendor-locked. This layer exists so the model is a swappable detail — connect a key later and every worker upgrades at once, with no rewrites.",
      flow: ["Worker → Bridge", "→ Provider Manager", "→ selected provider", "→ response", "→ back to the worker"],
      quickStart: ["Open Intelligence → Providers", "See which are live vs provisioned", "Open Manager to watch live routing per worker", "Add a Claude key in Settings to light up the Neural Link"],
      sandbox: { text: "The Local Cortex executes with zero setup — the Manager tab shows exactly which provider each worker resolves to, including failover reasons, before you connect any key." },
      best: ["Run on the Local Cortex until you need live quality", "Let 'auto' route by task category", "Store API keys in the encrypted vault, never in plain text"],
      mistakes: [
        { bad: "Assuming an API key is required to start", good: "The Local Cortex works with none" },
        { bad: "Pinning every worker to one provider", good: "Use auto-routing to match provider to task" }
      ],
      related: ["bridge", "runtime", "production"],
      advanced: ["The capability matrix drives which provider can handle reasoning/coding/etc.", "Unavailable providers fail over to the Local Cortex with the switch logged"],
      checklist: ["Open the Providers tab", "Read the routing Manager", "Check the capability matrix", "Toggle a provider"]
    },
    {
      key: "runtime", icon: "⚡", name: "Worker Runtime", route: "#/runtime",
      tagline: "Turn one worker into fully executable intelligence — one task at a time.",
      whatIs: "The Runtime makes one designated Worker executable. Every run loads memory, routes through the Bridge and Provider Manager, executes its workflow, updates shared memory, logs events and reports back for your evaluation.",
      why: ["Run a reliable single-worker loop", "Watch a mission execute live", "Evaluate and improve output quality"],
      whyBuilt: "Reliability before scale. Before distributing work across many agents, one worker has to run a complete, observable mission end-to-end. The Runtime exists to prove that loop works before you expand.",
      flow: ["Activate the First Intelligence", "Queue a task", "Run Worker", "Live monitor shows each step", "Evaluate → lesson stored"],
      quickStart: ["Open Runtime", "Activate a clone as the First Intelligence", "Queue a task and click Run Worker", "Watch the live monitor, then score the output"],
      sandbox: { text: "Activate any demo clone, queue a task and run it — the live monitor walks through memory load, provider selection and workflow steps, then hands you the output to score." },
      best: ["Keep a clear standing objective", "One task at a time — reliability first", "Score honestly; lessons flow into Knowledge"],
      mistakes: [
        { bad: "Queueing ten tasks and running blind", good: "Run one, evaluate, then continue" },
        { bad: "Skipping evaluation", good: "Scoring writes the lesson that improves next time" }
      ],
      related: ["forge", "knowledge", "missions"],
      advanced: ["A run's output can publish straight to the Broadcast Queue via the Execution Layer", "The Worker Inspector shows any worker on the universal schema"],
      checklist: ["Activate the First Intelligence", "Queue a task", "Run the worker", "Evaluate the output", "Open the Worker Inspector"]
    },
    {
      key: "integrations", icon: "🔌", name: "Execution Layer", route: "#/integrations",
      tagline: "Every external action routes through one engine — dry-run by default.",
      whatIs: "The Execution Layer is the universal engine for external actions. Any worker's outbound action flows Worker → Bridge → Execution Engine → adapter. Dry Run simulates safely; Live mode is real only where a browser can genuinely reach.",
      why: ["Send DMs, emails and posts through one place", "Store API keys encrypted, once", "Test flows safely before going live"],
      whyBuilt: "Letting each worker touch external services directly is unsafe and unauditable. This layer exists so every side-effect passes one permissioned, logged choke point — with an honest line between what's real and what's simulated.",
      flow: ["Pick action + acting worker", "Choose Dry Run or Live", "Engine runs it via the adapter", "Result → history + memory + events"],
      quickStart: ["Open Integrations → Actions", "Pick an action and a worker", "Keep it on Dry Run", "Execute and read the monitor + history"],
      sandbox: { text: "Dry Run is the default and touches nothing — run any of the 27 registered actions to see the full execution monitor and history without side effects." },
      best: ["Stay on Dry Run until a flow is proven", "Grant workers only the action categories they need", "Store credentials in the vault, never in a worker"],
      mistakes: [
        { bad: "Flipping to Live before testing", good: "Dry Run first — no silent failures" },
        { bad: "Pasting keys into task text", good: "Use the encrypted credential vault" }
      ],
      related: ["queue", "bridge", "runtime"],
      advanced: ["Live is real only for browser-reachable transports (Telegram, webhooks, Supabase, the Broadcast Queue)", "Least-privilege worker permissions are enforced per action category"],
      checklist: ["Open the Actions tab", "Run a Dry Run action", "Check the execution history", "Set a worker permission"]
    },
    {
      key: "knowledge", icon: "📚", name: "Knowledge Network", route: "#/knowledge",
      tagline: "The long-term memory every worker consults before acting and feeds after.",
      whatIs: "The Knowledge Network is a searchable, linked, layered vault of frameworks, SOPs, lessons and decisions. Workers retrieve relevant context before executing and write lessons back after — it grows with every task.",
      why: ["Stop re-explaining the same context", "Turn wins into reusable playbooks", "Give every worker your best thinking"],
      whyBuilt: "Knowledge trapped in your head doesn't scale and knowledge scattered in files can't be retrieved at the moment of work. This vault exists so context is captured once and surfaced automatically whenever an agent needs it.",
      flow: ["Add knowledge (or a worker writes a lesson)", "It's auto-classified + linked", "Workers retrieve it before tasks", "Retrievals + confidence re-rank it"],
      quickStart: ["Open Knowledge → Vault", "Add a document (framework, SOP, note)", "Try Semantic Search for it by meaning", "Open the Graph to see how it links"],
      sandbox: { text: "Add a few documents and use Semantic Search — meaning-expanded retrieval finds them by concept, and the Graph tab visualizes the links and retrieval counts." },
      best: ["Tag and layer documents so retrieval is sharp", "Verify high-value docs to boost their confidence", "Let the Learning Engine capture 4★+ mission lessons"],
      mistakes: [
        { bad: "Dumping everything as one giant note", good: "Split into titled, tagged, layered docs" },
        { bad: "Never verifying anything", good: "Verify the docs you trust most" }
      ],
      related: ["runtime", "missions", "evolution"],
      advanced: ["Search is meaning-expanded lexical retrieval (synonym graph + confidence/freshness re-ranking), labeled honestly until a vector store connects", "Confidence rises with retrievals and verification"],
      checklist: ["Add a document", "Run a semantic search", "Open the graph", "Verify a document"]
    },
    {
      key: "missions", icon: "🎯", name: "Mission Control", route: "#/missions",
      tagline: "Turn one objective into a dependency graph of tasks executed by collaborating workers.",
      whatIs: "Mission Control coordinates multiple Workers to complete complex objectives by breaking a mission into a dependency graph of smaller executable tasks — planned, assigned, executed and monitored, with automatic failure recovery.",
      why: ["Launch a SaaS", "Manage an AI agency", "Run client work", "Build marketing campaigns"],
      whyBuilt: "Coordinating multiple AI workers by hand doesn't scale — you lose track of dependencies, ordering and who's doing what. Mission Control centralizes planning, execution and monitoring so complex objectives complete reliably instead of stalling halfway.",
      flow: ["Create mission", "Mission planner builds the task graph", "Workers assigned", "Execution (chained context)", "Knowledge stored", "Mission completed"],
      quickStart: ["Open Missions → pick a template (one click builds the graph)", "Click Plan Mission", "Open the mission and Run Next Task (or Run auto)", "Watch the dependency graph light up as tasks complete"],
      sandbox: { text: "Example mission — Launch AI Prompt Pack: Research Worker → Copy Worker → Publishing Worker → Complete. Pick the matching template and run it to explore the full graph without touching real work." },
      best: ["Start from a template, then customize", "Let the planner assign workers by role match", "Save a successful mission as a reusable template"],
      mistakes: [
        { bad: "Building every mission from scratch", good: "Reuse a mission template — it's the flywheel" },
        { bad: "Running the whole thing before checking the graph", good: "Read the dependency graph first, then run" }
      ],
      related: ["forge", "knowledge", "network", "enterprise"],
      advanced: ["Failure recovery escalates retry → reassign → escalate → pause → resume from checkpoint; completed tasks are never redone", "Missions can be distributed across network nodes"],
      checklist: ["Create a mission", "Add / confirm workers", "Run the mission", "Complete the mission", "Verify knowledge was stored"]
    },
    {
      key: "evolution", icon: "🧬", name: "Evolution Engine", route: "#/evolution",
      tagline: "The system measures itself, proposes improvements, and deploys nothing without your approval.",
      whatIs: "The Evolution Engine scores every worker, finds weaknesses, proposes improvements and runs controlled A/B experiments — but nothing deploys until you approve it. Safe, reversible self-improvement.",
      why: ["Find your weakest workers", "Prove changes with real A/B tests", "Improve without breaking what works"],
      whyBuilt: "Systems that self-modify without oversight drift into chaos. This engine exists to make improvement measurable and safe — every change is suggested, approved, applied, monitored and reversible, so you upgrade with confidence instead of hope.",
      flow: ["Run performance analysis", "Suggestions generated", "You approve → apply", "Monitor the effect", "Accept or roll back"],
      quickStart: ["Open Evolution → Run Performance Analysis", "Review the suggestions it proposes", "Approve one, then Apply it", "Watch it under monitoring, then Accept or Roll back"],
      sandbox: { text: "Run an A/B experiment in the Experiments tab (e.g. with-knowledge vs without) — it does two real generations and declares a winner, so you see the method before trusting it." },
      best: ["Approve one change at a time and watch its effect", "Save a prompt version before editing a worker", "Roll back fast if a change underperforms"],
      mistakes: [
        { bad: "Auto-accepting every suggestion", good: "Approve deliberately — you're the gate" },
        { bad: "Editing prompts with no version saved", good: "Snapshot first; roll back is instant" }
      ],
      related: ["forge", "knowledge", "bridge"],
      advanced: ["Every prompt is version-controlled with performance-since tracking", "Manual applies are marked honestly where a human must act"],
      checklist: ["Run a performance analysis", "Approve a suggestion", "Apply and monitor it", "Run an A/B experiment", "Roll back a change"]
    },
    {
      key: "enterprise", icon: "🏛", name: "Enterprise OS", route: "#/enterprise",
      tagline: "Run whole businesses on one operating system — CRM, ledger, projects, teams.",
      whatIs: "Enterprise OS runs every business you build inside PRISM-X on shared infrastructure: organizations, CRM pipeline, a real bookkeeping ledger, projects wired to Mission Control, teams, automations and executive reporting.",
      why: ["Run an agency with real clients", "Keep honest books", "Deploy a whole business in one click"],
      whyBuilt: "Agents make money, but a business also needs clients, invoices, projects and reporting. Enterprise OS exists so all of that lives in one place with an honest ledger — simulated agent earnings are tagged [SIM] and never silently mixed with real bookkeeping.",
      flow: ["Deploy a business template", "Add clients to the CRM", "Record ledger entries", "Open projects → wire to missions", "Executive report"],
      quickStart: ["Open Enterprise → Organizations", "Deploy a business template (org + CRM + worker + automation)", "Add a client in the CRM tab", "Generate an executive report"],
      sandbox: { text: "Deploy the AI Agency template — it stands up an organization, CRM, a worker, a playbook and an automation in one click, so every tab is populated to explore." },
      best: ["Deploy from a template, then tailor", "Import SIM earnings only as clearly-tagged entries", "Wire projects to Mission Control for execution"],
      mistakes: [
        { bad: "Mixing simulated earnings into real books", good: "Keep [SIM] separate — the ledger enforces it" },
        { bad: "Managing clients in your head", good: "Use the CRM pipeline stages" }
      ],
      related: ["matrix", "missions", "network"],
      advanced: ["CRM automations orchestrate real records across mission control, the execution layer and the ledger", "Enterprise roles map onto the Bridge Permission Engine"],
      checklist: ["Deploy an organization", "Add a client", "Record a ledger entry", "Open a project", "Generate a report"]
    },
    {
      key: "extensions", icon: "📦", name: "Extension Ecosystem", route: "#/extensions",
      tagline: "PRISM-X as a platform — every new capability installs as an extension; the core never changes.",
      whatIs: "The Extension Center makes PRISM-X a platform. New capabilities install, update, configure and uninstall through one manager, follow a single SDK, subscribe to the event bus and reach the system only through permission-scoped APIs.",
      why: ["Add capability without editing the core", "Approve exactly what an extension can touch", "Keep upgrades clean and reversible"],
      whyBuilt: "Bolting features into the core makes it fragile and un-upgradeable. The extension model exists so the core stays stable forever while capabilities are added, versioned and removed independently — with owner approval gating every permission.",
      flow: ["Browse the catalog", "Install an extension", "Approve its permissions", "It activates + mounts UI", "Update or uninstall anytime"],
      quickStart: ["Open Extensions → Extension Center", "Install one from the private catalog", "Approve its requested permissions", "Enable it, then explore its mounted widget or page"],
      sandbox: { text: "Install a catalog extension like System Pulse — it asks for permissions, you approve, and it mounts a live dashboard widget; uninstall leaves the core untouched." },
      best: ["Read the permissions before approving", "Install only extensions you trust", "Uninstall cleanly — the core is never modified"],
      mistakes: [
        { bad: "Approving permissions blindly", good: "Review the scoped APIs it will reach" },
        { bad: "Expecting hard sandboxing", good: "Same-page runtime is convention-enforced; trust matters" }
      ],
      related: ["bridge", "production", "network"],
      advanced: ["The Developer tab exposes the scoped API surface, event bus and a live sandbox", "The manifest contract is validated before any install"],
      checklist: ["Install an extension", "Approve its permissions", "Enable it", "Open its page/widget", "Uninstall it"]
    },
    {
      key: "network", icon: "🌍", name: "Distributed Network", route: "#/network",
      tagline: "The architecture for infinite scale — nodes, distribution, sync, failover and backups.",
      whatIs: "The Network Control Center is the distributed-intelligence layer: register nodes, distribute a mission's tasks across them, synchronize knowledge, balance the worker pool, federate organizations and recover from failure with snapshots.",
      why: ["Plan for horizontal scale", "Keep running when a node fails", "Sync knowledge across a fleet"],
      whyBuilt: "A single browser tab has limits. This layer exists so the coordination logic for many nodes — scheduling, distribution, failover, sync — is real and ready now; connecting remote runtimes later is a store-adapter swap, not a redesign.",
      flow: ["Register nodes", "Distribute a mission across them", "Sync knowledge (conflict-resolved)", "A node fails → failover", "Snapshot for recovery"],
      quickStart: ["Open Network → Control", "Register a node or two", "Open Distribution and distribute a mission", "Take a snapshot in Recovery"],
      sandbox: { text: "This browser is the real PRIME node; register a couple more, simulate a failure and watch failover move its tasks to the healthiest survivor — all coordination logic is real, remote telemetry is labeled simulation." },
      best: ["Snapshot before risky changes", "Federate org sharing deliberately (isolated by default)", "Use sync policies to control what a node writes"],
      mistakes: [
        { bad: "Treating simulated node telemetry as live", good: "It's labeled sim until remote runtimes connect" },
        { bad: "No restore points", good: "Take snapshots — recovery depends on them" }
      ],
      related: ["missions", "enterprise", "production"],
      advanced: ["Conflict resolution: higher confidence wins, freshness breaks ties", "The enterprise path swaps the store for a server adapter with identical APIs"],
      checklist: ["Register a node", "Distribute a mission", "Simulate a failure", "Take a snapshot", "Balance the worker pool"]
    },
    {
      key: "production", icon: "🚀", name: "Production Center", route: "#/production",
      tagline: "Make everything you've built secure, observable, recoverable and validated as one platform.",
      whatIs: "The Production Center is where the whole platform becomes production-grade: an access lock and audit trail, a health center, structured logs and traces, selective recovery, configuration, deployment profiles, docs and a validation suite.",
      why: ["Lock the app on a shared machine", "Diagnose issues fast", "Prove readiness before you rely on it"],
      whyBuilt: "Building features is only half the job — shipping means it must be secure, observable, recoverable and verifiable. This center exists so everything already built graduates into one production-ready platform instead of a pile of features.",
      flow: ["Set an access passcode", "Watch health + logs", "Configure profile + policies", "Run the validation suite", "Green → production-ready"],
      quickStart: ["Open Production → Health Center for a system score", "Open Validation and Run the Suite", "Read the readiness report (READY / NOT READY)", "Optionally enable the access lock in Security"],
      sandbox: { text: "Run the Production Validation Suite — it checks permissions, integrations, providers, workflows, knowledge, missions, extensions, network, storage and configuration, then returns a full readiness report." },
      best: ["Run the validation suite before trusting a deploy", "Use production profile to disable risky sandboxes", "Keep restore points current in Recovery"],
      mistakes: [
        { bad: "Assuming the passcode is unbreakable", good: "It deters casual access; it's not disk encryption" },
        { bad: "Deploying without a green suite", good: "Production profile expects it green first" }
      ],
      related: ["bridge", "network", "extensions"],
      advanced: ["Boot runs migrations snapshot-first with rollback kept", "The Docs tab is a full in-app documentation hub with a live API reference"],
      checklist: ["Open the Health Center", "Run the validation suite", "Read the readiness report", "Enable the access lock", "Take a config export"]
    }
  ];

  const BY_KEY = {};
  ACADEMY.forEach(m => { BY_KEY[m.key] = m; });

  /* routes/views that should resolve to a lesson's key for context help */
  const ROUTE_ALIAS = {
    clone: "forge", "ghost-forge": "ghosts", ghost: "ghosts",
    "shell-forge": "shells", shell: "shells", mission: "missions",
    worker: "runtime", ext: "extensions", memory: "bridge", settings: "production"
  };

  function all() { return ACADEMY; }
  function module(key) { return BY_KEY[key] || null; }
  function keyForView(view) { return BY_KEY[view] ? view : (ROUTE_ALIAS[view] || null); }

  /* ------------------------------------------------------------------ *
   * Global "how do I…" search — lexical, weighted, offline.
   * ------------------------------------------------------------------ */
  const STOP = new Set(["how","do","does","the","a","an","to","i","is","are","what","why","when","of","in","on","for","with","and","my","use","can","it","this"]);
  function tokens(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w && w.length > 1 && !STOP.has(w));
  }
  function haystack(m) {
    return [
      m.name, m.name, m.tagline, m.whatIs, m.whyBuilt,
      m.why.join(" "), m.flow.join(" "), m.best.join(" "),
      m.advanced.join(" "), m.checklist.join(" "),
      m.mistakes.map(x => x.good + " " + x.bad).join(" ")
    ].join(" ");
  }
  function search(query) {
    const qs = tokens(query);
    if (!qs.length) return [];
    return ACADEMY.map(m => {
      const nameSet = new Set(tokens(m.name));
      const hay = haystack(m).toLowerCase();
      let score = 0;
      qs.forEach(q => {
        if (nameSet.has(q)) score += 6;
        const hits = (hay.match(new RegExp("\\b" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
        score += Math.min(hits, 4);
      });
      return { module: m, score };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  }

  /* ------------------------------------------------------------------ *
   * Checklist progress — the only persisted state.
   * ------------------------------------------------------------------ */
  function ensure() {
    const st = S().state;
    st.academy = st.academy || { checklist: {} };
    if (!st.academy.checklist) st.academy.checklist = {};
    return st.academy;
  }
  function checkState(key) { return ensure().checklist[key] || {}; }
  function toggleCheck(key, idx, on) {
    const ac = ensure();
    ac.checklist[key] = ac.checklist[key] || {};
    ac.checklist[key][idx] = !!on;
    S().save();
  }
  function progress(key) {
    const m = module(key); if (!m) return { done: 0, total: 0 };
    const cs = checkState(key);
    const done = m.checklist.reduce((a, _, i) => a + (cs[i] ? 1 : 0), 0);
    return { done, total: m.checklist.length };
  }
  function overall() {
    let done = 0, total = 0;
    ACADEMY.forEach(m => { const p = progress(m.key); done += p.done; total += p.total; });
    return { done, total, modules: ACADEMY.length };
  }

  return { all, module, keyForView, search, ensure, checkState, toggleCheck, progress, overall };
})();
