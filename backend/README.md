# PRISM-X Backend — Phases 1–6
### Core Foundation · Intelligence & Execution · Automation & Integration · Distributed Intelligence · Learning & Optimization · Evolution

The production backend for the PRISM-X Intelligence Operating System. It is a
standalone service: it holds all business logic, owns the data model, and is
consumed over HTTP. The existing browser app, and any future desktop, mobile or
third-party client, are peers talking to the same API.

```
Clients (web · desktop · mobile · public API)
        │  REST + JWT
        ▼
  NestJS application  ── the control plane, and the single source of truth
        ├── Guards (JWT → RBAC)          ── every route locked by default
        ├── Feature modules              ── controller · service · DTOs
        ├── Repository layer             ── the ONLY place that queries the DB
        ├── Event bus                    ── durable domain events
        ├── Provider registry            ── vendor-neutral intelligence seam
        └── Node scheduler               ── which machine runs what
        │
        ├──────────────► Nodes (local · another PRISM-X over HTTP)
        ▼                      capacity only; they decide nothing
  Prisma ──► PostgreSQL (+ row-level security)
  Redis  ──► cache · BullMQ queues
```

---

## Running it

```bash
cp .env.example .env          # fill in, then:
npm install
npx prisma migrate deploy     # schema + RLS policies
npm run db:seed               # permissions + system roles
npm run build && npm start
```

The API listens on `:3000/api/v1`; Swagger UI is at `:3000/docs`.

Requirements: PostgreSQL 14+, Redis 6+, Node 20+.

---

## Architectural decisions

### Supabase is the data platform, not the application

Supabase is reached through two adapters and nothing else:

| Concern | Interface | Implementations |
|---|---|---|
| Identity | `IAuthProvider` | `SupabaseAuthProvider`, `LocalAuthProvider` |
| Files | `IStorageDriver` | `SupabaseStorageDriver`, `LocalStorageDriver` |

Everything above those interfaces — roles, permissions, org membership,
mission rules — lives in this codebase and in our own tables. Swapping identity
providers touches one file.

Prisma connects to Postgres directly, which is also how you connect to Supabase
(it hands you a Postgres connection string), so moving between a self-hosted
database and Supabase is a `DATABASE_URL` change.

`AUTH_PROVIDER=local` / `STORAGE_DRIVER=local` exist so the service runs and is
fully testable with no external accounts — used by CI and the validation suite.
The env validator warns if the local auth driver is used in production.

### Tenant isolation is enforced twice, independently

**Application layer.** `BaseRepository` merges `organizationId` — taken from the
ambient `RequestContext`, never from a parameter or request body — into every
query, and stamps it on every insert. There is no code path that reaches the
database with a caller-supplied organization id. With no authenticated context
the repository throws rather than running an unscoped query: it fails closed.

**Database layer.** Every tenant table carries an RLS policy keyed on
`current_setting('app.current_organization_id')`, with `WITH CHECK` so a
constrained session cannot write another tenant's rows either. The backend's
service-role connection is trusted across tenants by design (as with Supabase's
service key); the policies constrain everything else that reaches the database —
PostgREST/`supabase-js` clients, analytics tools, psql sessions, future
services. `prismx_tenant` is the least-privilege role that models those callers.

Both layers are covered by the validation suite, including the negative cases:
no context → zero rows; cross-tenant read → 404; cross-tenant insert → policy
violation.

### The RequestContext is middleware, not an interceptor

`AsyncLocalStorage` must be entered before guards run and stay open through the
handler. An interceptor cannot do this — it returns a lazy Observable, and the
`run()` scope closes before Nest ever subscribes. `RequestContextMiddleware`
calls `next()` *inside* the scope; `JwtAuthGuard` then fills the stored object
in place once the caller is known.

### Repositories declare constructors that only call `super()`

They look redundant and are not. TypeScript emits `design:paramtypes` metadata
only for classes that declare a constructor; without it Nest injects nothing
into the inherited constructor and `prisma` is `undefined` at runtime.

### Providers: the seam ships before the vendors

`IIntelligenceProvider` defines completion, embedding and health-check shapes in
vendor-neutral terms. `ProviderRegistry` resolves a stored provider record into
an adapter, decrypting its credential — the only place decryption happens.

Phase 1 shipped this registry deliberately empty — the seam before the vendors.
Phase 2 fills it with seven adapters (see below). Because registration is the
only coupling point, that was one factory per vendor and one line in
`ProviderManager.onModuleInit()`; no business logic changed. A `ProviderKind`
with no registered adapter still raises `ProviderNotImplementedError` and
reports `healthy: false` with an explanation rather than a false success.

### Credentials

API keys and tokens are sealed with AES-256-GCM before they touch the database.
GCM (not CBC) so a tampered row fails to decrypt instead of yielding plausible
garbage. The API never returns a key — only a four-character hint (`****f3a9`).

---

## Layout

```
src/
├── config/          typed configuration + fail-fast env validation
├── shared/          context · crypto · cache · filters · interceptors · DTOs
├── database/        PrismaService + the repository layer
├── events/          domain event catalogue + bus + event log API
├── auth/            providers · guards · RBAC · decorators
├── organizations/   workspaces + membership
├── workers/         autonomous agents
├── missions/        missions, tasks, the DAG and its state machine
├── knowledge/       stored knowledge and search
├── providers/       provider registration + the intelligence seam
├── integrations/    external connectors
├── extensions/      installed extensions + event fan-out
├── analytics/       aggregate metrics
├── notifications/   event → notification channels
├── storage/         object storage abstraction
├── queues/          BullMQ queues
├── nodes/           the fleet register, node security, transports
├── distributed/     scheduling · queues · replication · federation · monitoring
├── learning/        confidence · reviews · analytics · recommendations · patterns
├── evolution/       the Constitution · candidates · experiments · deployment
└── health/          liveness + dependency checks
```

Each feature module owns its controller, service, DTOs and validation. Business
logic never leaves its module, and never talks to Prisma directly.

---

## Authorization

Four seeded system roles over 55 `resource:action` permissions:

| Role | Scope |
|---|---|
| `OWNER` | Everything, including deleting the organization |
| `ADMIN` | Everything except deleting the organization |
| `OPERATOR` | Full CRUD on workers, missions and knowledge; may see the fleet and run work on it; read-only elsewhere |
| `VIEWER` | Read-only |

Registering or decommissioning machines (`node:register`, `node:delete`) and
lending them to another organization (`federation:grant`, `federation:revoke`)
stay with administrators. Federation is its own permission rather than an
implication of node administration, because its blast radius is a *different*
organization's data rather than this one's uptime.

Learning is split four ways for the same reason: reading what the system
concluded (`learning:read`), triggering analysis (`learning:run`), deciding
whether a conclusion is right (`learning:approve`), and letting it touch
production (`learning:apply`) are genuinely different levels of trust.
Evolution splits the same way again (`evolution:read`, `:run`, `:approve`,
`:deploy`, `:policy`) — and no permission anywhere grants the ability to
amend the Constitution, because that is not something a permission can do.

`JwtAuthGuard` and `PermissionsGuard` are registered globally, so a new route is
protected unless it opts out with `@Public()`. A caller missing a permission
gets a 403 naming exactly which one.

Accounts belonging to several organizations select one with the
`X-Organization-Id` header; otherwise the first active membership is used.
Resolved membership and permissions are cached in Redis for 300s, so a revoked
role stops working within minutes without a cache bust on every write.

---

## Events

Every state change publishes a domain event, which is persisted to the `events`
table *before* dispatch — so a subscriber added later can replay history, and the
record does not depend on any listener being registered at the time. A throwing
subscriber is logged and swallowed: creating a worker must not fail because an
analytics listener has a bug.

`user.registered` · `organization.created` · `worker.created` ·
`worker.activated` · `mission.started` · `mission.completed` · `mission.failed` ·
`task.completed` · `knowledge.stored` · `provider.connected` ·
`integration.created` · `extension.installed` — full catalogue in
`src/events/domain-events.ts`.

---

## Testing

```bash
npm test                        # 39 unit tests
node test/phase1-validation.js  # 57 checks against a running server
```

The validation suite covers the Phase 1 acceptance criteria end-to-end against
live Postgres and Redis: authentication, persistence of every core entity, the
mission lifecycle, event emission, cross-organization isolation (read, write and
delete attempts), RBAC edge cases, both layers of RLS, Swagger completeness, and
the architectural invariants — that the Supabase SDK appears only in its two
adapters, and that no business service imports Prisma.

Latest run: **57/57 checks, 39/39 unit tests.**

---

---

# Phase 2 — Intelligence & Execution Engine

Phase 1 made the system storable. Phase 2 makes it *run*: workers execute,
missions orchestrate themselves, and every call is priced and traced.

## Provider Manager

Every AI call passes through `ProviderManager`. Nothing above it knows which
vendor served a request — the runtime and orchestrator call `complete()` and the
manager decides.

Seven adapters are registered at boot: **OpenAI**, **Anthropic**, **Gemini**,
**Hermes**, **Ollama**, **Custom** (any OpenAI-compatible endpoint), and
**Local** (see below). Adapters are thin by design: each maps our
vendor-neutral shapes onto one wire format and nothing else. Retries, rate
limiting, failover, cost accounting and health tracking all live in the manager,
so they behave identically whichever vendor is serving.

- **Retries** — up to 3 attempts with exponential backoff, but only for
  failures the adapter classified as retryable. A 401 or malformed request
  fails immediately rather than being retried into the same error.
- **Failover** — a failed provider falls back to another healthy one, unless
  the worker sets `allowFailover: false` to pin itself.
- **Circuit breaker** — three consecutive failures bench a provider for 60s.
- **Rate limiting** — fixed-window per provider in Redis; yields rather than
  blocks when Redis is down.
- **Health** — latency tracked as an exponential moving average, so a
  degradation shows up in minutes rather than being buried in an all-time mean.

### The `LOCAL` adapter is not a mock

`ProviderKind.LOCAL` is a real registered adapter that runs in-process with no
network and no key. It exists because the substance of this phase — scheduling,
memory, tools, logging, cost — must be verifiable without a funded third-party
endpoint. It is deterministic (output derives from a hash of the request), it
reports **real** token counts computed from actual text, and it supports fault
injection (`config.simulate`) so retry, circuit-breaking and failover are
testable without waiting for an outage.

**This means the orchestration layer is proven end-to-end; the vendor adapters
themselves are written against each vendor's documented API but have not been
executed against live vendor endpoints in this environment, since no API keys
are present.** Supply a key and the same code path runs unchanged.

## Worker Runtime

A worker is now an executable identity: system prompt, skills, provider,
default model, temperature, granted tools, and hard execution limits
(iterations, tokens, wall-clock, cost ceiling, failover).

`WorkerRuntimeService` assembles four things into every prompt — standing
instructions, recalled memory, retrieved knowledge, and the tool catalogue —
then runs the tool loop within those limits and records what happened. The
budget is checked *after each call*, so a runaway worker is stopped mid-flight
rather than after it has spent.

Tool calling uses one text protocol (`TOOL_CALL: {...}`) across every provider
rather than each vendor's native format, so a worker behaves identically on
Anthropic and Gemini. Native tool calling can be adopted per-adapter later
without changing that contract.

## Mission Orchestrator

Full lifecycle: `DRAFT → QUEUED → PLANNING → RUNNING → [WAITING] → COMPLETED →
ARCHIVED`, plus `PAUSED`, `FAILED` and `CANCELLED`. Transitions are encoded as
one table shared by the CRUD controller and the engine, so they cannot disagree.

- **Planning** assigns a worker to each task by role and skill match
  (deterministic, so the same graph plans the same way twice) and records the
  dependency waves.
- **Execution** is a topological walk: each pass asks which tasks have all
  dependencies satisfied, runs that wave with bounded concurrency, then asks
  again. Upstream outputs become downstream context.
- **Mission status is derived** from task state after every wave rather than
  tracked separately — two sources of truth would eventually disagree.
- **Recovery** — per-task retries with backoff, mission-level retry that resets
  failed tasks, resume from `PAUSED`/`WAITING`, and cancel that skips
  never-started tasks so a cancelled mission cannot look resumable.

## Memory Engine

Two tiers with different jobs. **Short-term** carries current execution context
and expires on a TTL. **Long-term** holds learned strategies, preferences and
outcomes, and never expires.

Retrieval is *ranked*, not chronological, because the binding constraint is the
context window: a worker gets a handful of memories, so they must be the right
handful. Score blends keyword relevance, assigned importance, and exponential
recency decay — softened for long-term entries, since outlasting decay is the
reason they were promoted.

Consolidation promotes a memory only when it is both important **and**
repeatedly accessed. Importance alone would fill long-term memory with things
written confidently and never used again.

## Knowledge Retrieval

Workers state what they need and receive ranked, excerpted documents ready for a
prompt. Ranking rewards term *coverage* over raw match counts (raw counts favour
long documents that mention a term incidentally), weights title and tag matches
above body matches, and damps by document length. Excerpts are taken from the
densest cluster of query terms, so they show *why* a document matched.

`IRetrievalStrategy` makes keyword → vector → hybrid a swap behind the
interface. The vector strategy is present and inert until embeddings are
backfilled.

## Tools

Nine built-in tools spanning knowledge, missions, tasks, workers, organization,
storage, notifications and analytics. Every invocation passes two independent
checks before any tool code runs:

1. **The worker's grant** — `worker.toolPermissions`. Empty means no tools;
   capability is granted explicitly, never by default.
2. **The caller's permission** — the tool's `requiredPermission`. A worker can
   never exceed the authority of whoever started the mission.

Denials are recorded, not dropped: a worker repeatedly reaching for a tool it
lacks is a signal worth seeing.

## Execution logs, cost & usage

Every AI call writes an `ExecutionLog` — worker, mission, task, provider, model,
prompt, tokens, cost, latency, attempts, error, timing. `usage_daily` is a
rollup written from the same code path so a dashboard spanning months does not
scan every call.

**On cost precision:** token counts are recorded exactly and are authoritative.
Cost is a *derived reporting figure* — tokens × a rate table that is
operator-overridable per provider (`config.pricing`). Vendor pricing drifts, so
verify the rates in `model-catalogue.ts` before treating the cost dashboard as
financial. Cost is always recomputable from the stored token counts.

## Testing

```bash
npm test                        # 76 unit tests
node test/phase1-validation.js  # 57 checks
node test/phase2-validation.js  # 58 checks
```

Phase 2's suite covers all ten required checks against live Postgres and Redis:
provider switching and failover, worker execution through the manager, complete
mission runs, dependency ordering, memory recall feeding the prompt, knowledge
retrieval, tool execution *and denial*, log generation, cost attribution across
five dimensions, and the full event catalogue. It also re-verifies that
organization isolation still holds over all the new surfaces.

Latest run: **58/58 Phase 2, 57/57 Phase 1, 76/76 unit tests.**

## What Phase 2 deliberately does not do

- **No live vendor calls in this environment.** Adapters are written against
  each vendor's documented API; without keys they are unexercised against real
  endpoints. The orchestration around them is fully proven via the `LOCAL`
  adapter.
- **No semantic retrieval yet.** The vector strategy exists behind the
  interface but embeddings are not backfilled, so keyword ranking is active.
- **No sandboxed extension execution.** Event fan-out to extensions is wired
  and logged; running third-party code safely is a later phase.
- **No mail transport.** Notifications resolve to a logging channel that states
  what it would have sent, rather than silently dropping messages.


---

# Phase 3 — Automation & Integration Platform

Phase 2 made the system think. Phase 3 connects it to the world: external
services, event-driven workflows, human approvals, and a public API.

## The orchestration decision

**PRISM-X does not try to be a better n8n.** The workflow engine owns *control
flow* — order, branching, parallelism, loops, retries, suspension — and hands
each unit of actual work to an **execution adapter**:

```
Workflow Engine
     │
     ▼
Execution Adapter
     ├── internal   — workers, integrations, missions, HTTP
     ├── n8n        — trigger an n8n workflow, collect its result
     ├── make       — trigger a Make.com scenario
     └── future runtimes
```

PRISM-X decides *what* should happen and why; the adapter decides *how*.
Adopting n8n or Make later is a step type, not a rewrite — and a single
workflow can mix runtimes step by step. PRISM-X stays the source of truth for
intelligence, missions, workers and business rules.

Delegated steps carry `x-prismx-run-id` / `x-prismx-step-id` headers so a run
is traceable across both systems.

## Integrations & connectors

Every external call goes through the **Integration Manager** — retries with
backoff, a five-strike circuit breaker, per-integration rate limiting,
credential decryption, and usage accounting, applied identically to Slack,
Stripe and a bespoke endpoint alike.

Connectors are **declarative**. A service is a ~20-line spec (base URL, how the
credential attaches, one line per action), not a subsystem:

| Category | Connectors |
|---|---|
| Messaging | Slack, Telegram, Discord |
| Email | Gmail |
| CRM | HubSpot |
| Payment | Stripe |
| Database | Notion, Airtable |
| Custom | GitHub, generic REST, simulated |

Actions declare the permission they need, checked against the integration's
granted scope *before* the call leaves the process — an integration configured
read-only cannot be talked into writing by a workflow step.

## Workflow engine

Steps: `worker` · `integration` · `mission` · `http` · `condition` · `parallel`
· `loop` · `delay` · `approval` · `ai_decision` · `transform` · `n8n` · `make`.

- **Versioning is immutable.** Editing publishes a new version; a run in flight
  keeps executing the definition it started with, and an audit can always
  answer "what did this run actually do".
- **Templates** clone into new drafts, so a good approval-and-notify flow is
  built once.
- **Structural validation at authoring time** — duplicate ids, dangling
  dependencies, a `fallback` policy with no fallback — caught before a version
  is stored rather than halfway through a production run.
- **Suspension is first-class.** An approval or a long delay parks the run;
  resuming settles the suspending step from the recorded decision rather than
  re-executing it (which would ask the same question forever).

## Triggers

Three sources, one path — resolve the organization, evaluate the condition, map
the payload, start a run:

- **Internal** — any domain event on the bus.
- **External** — inbound webhooks at an unguessable 32-character path, with
  constant-time HMAC-SHA256 verification. Unsigned or mis-signed requests are
  rejected before anything runs.
- **Scheduled** — cron (wildcards, numbers, lists, ranges, steps) or fixed
  interval. An unparseable expression falls back to hourly rather than silently
  never firing.

Triggers run outside any HTTP request, so each establishes its own
RequestContext — the repository layer's fail-closed scoping is never bypassed.

## AI decisions & human approval

A worker in a workflow never gets an open question. It receives a **closed set
of options** and must pick one; an answer outside the set is rejected rather
than accepted as novel. On top of that:

- **Confidence threshold** — a hesitant answer escalates to a human.
- **Cost limit** — a decision over budget fails rather than silently spending.
- **Always-require-approval** — for inherently consequential calls.

Approvals support **approve / reject / request changes / delegate**, each
carrying reason, context, suggested action and risk level. Approving resumes
the run; rejecting and requesting changes deliberately do not. Stale requests
expire, because an approval that sits forever silently blocks a run.

## Reliability

Nothing fails silently.

| Mechanism | Where |
|---|---|
| Retries with exponential backoff | Provider Manager, Integration Manager, workflow steps, webhook delivery |
| Timeouts | Per step, per connector call |
| Circuit breakers | Providers (3 strikes), integrations (5 strikes) |
| Rate limiting | Providers, integrations, API keys |
| Fallback actions | `onError: fail | continue | fallback` per step |
| Dead-letter queue | Exhausted runs and deliveries, with payload for replay |
| Duplicate detection | `idempotencyKey` returns the original run |
| Recovery | Resume suspended, retry failed, replay dead letters |

## Public API

- **API keys** — only a SHA-256 hash is stored; the plaintext is returned once
  and is unrecoverable. Scopes draw from the same permission catalogue as
  users, so a key can never exceed what the model already describes. Per-key
  rate limits, usage analytics, immediate revocation.
- **Outbound webhooks** — signed `t=<ts>,v1=<hmac>` over `<timestamp>.<body>`.
  The timestamp is signed too, so a captured delivery cannot be replayed.
  Exponential backoff, dead-lettering on exhaustion, and auto-disable after ten
  consecutive failures.

## Automation analytics

Measured and estimated figures are labelled differently on purpose:

- **Measured** — executions, success/failure rates, durations, tokens, AI cost,
  most-used integrations and workers.
- **Estimated** — hours saved, savings, ROI. These rest on an operator-supplied
  minutes-per-run assumption, which is returned alongside every estimate so a
  modelled number is never mistaken for a measured one. Only *successful* runs
  are credited with saving anything.

## Testing

```bash
npm test                        # 123 unit tests
node test/phase1-validation.js  # 57 checks
node test/phase2-validation.js  # 58 checks
node test/phase3-validation.js  # 74 checks
```

Phase 3's suite covers all ten required checks against live Postgres and Redis,
including the negative cases: permission-denied connector actions, unsigned and
mis-signed webhooks, unpublished workflows, malformed graphs, re-deciding a
settled approval, requesting changes without a comment, and cross-organization
access to every new surface.

Latest run: **74/74 Phase 3, 58/58 Phase 2, 57/57 Phase 1, 123/123 unit tests.**

## What Phase 3 deliberately does not do

- **No live third-party calls in this environment.** Connectors are written
  against each vendor's documented REST API; without credentials they are
  unexercised against real endpoints. The machinery around them — permissions,
  retries, circuit breaking, accounting — is fully proven via the `simulated`
  connector.
- **No OAuth2 flow.** The auth method is modelled and stored; the redirect
  dance is a later phase. Bearer and API-key auth work today.
- **No SMS transport.** Channels resolve to in-app plus whatever integrations
  are configured; an unconfigured channel is recorded as undelivered rather
  than reported as sent.
- **No visual workflow builder.** The engine is API-first; the canvas is a
  frontend concern.

---
---

# Phase 4 — Distributed Intelligence

Phase 4 turns one server into a fleet. PRISM-X still has exactly one brain —
the control plane owns missions, workers, memory and every business rule — but
execution can now happen on any machine that has registered itself as a node:
a laptop, a home server, a rented VPS, a GPU box, a Raspberry Pi.

Nothing above the transport layer knows the difference. The mission
orchestrator calls `WorkerRuntimeService.execute` exactly as it did in Phase 2;
whether that runs on this event loop or on a machine in another country is a
placement decision made underneath it.

```
        Control plane (single source of truth)
                    │
        ┌───────────┴───────────┐
        │   Node Scheduler      │  eligibility → preference
        │   Queue Coordinator   │  four queues · priorities · migration
        │   Failover            │  heartbeats · leases · quarantine
        │   Memory replication  │  op log · vector clocks · conflicts
        │   Federation          │  explicit, revocable, one-directional
        └───────────┬───────────┘
                    │  INodeTransport
      ┌─────────────┼─────────────┐
      ▼             ▼             ▼
   local         http          simulated
 (this process) (another      (a machine that
                 PRISM-X)      isn't there)
```

## Nodes are capacity, not authority

A node holds no state of its own that matters. It advertises what it can do,
reports what it is doing, and executes what it is handed. Every decision —
what runs, where, with what permissions, under whose tenancy — is made by the
control plane. That is what makes a node safe to add: an under-equipped or
compromised machine can refuse work or return rubbish, but it cannot decide
anything.

Registering a node is the whole of adding capacity. The node measures its own
hardware and discovers its own capabilities; scheduling begins the moment it
is trusted and heartbeating. There is no second place to go and describe the
machine, and nothing else in the system needs to be told the fleet got bigger.

Node types: `LOCAL_MACHINE`, `HOME_SERVER`, `CLOUD_VPS`, `DEDICATED_AI_SERVER`,
`EDGE_DEVICE`, `DEVELOPMENT_MACHINE`, `CUSTOM`. The last is the extension point
— new classes of machine are added there rather than smuggled into labels.

### The local node

Every organization gets a node for the control plane itself, created when the
organization is created. Without it, a single-machine install would have an
empty fleet and the scheduler nothing to choose from — the distributed path
would be strictly worse than the non-distributed one. The local node makes the
degenerate one-machine case an ordinary member of the general case.

Because it has no agent to heartbeat it, its capabilities are refreshed on
provider and extension changes, and whenever `POST /nodes/local` is called.

## Health is one number, composed from several

The scheduler needs a single comparable quantity, so health is 0..1. It is
built from four signals, and how they combine is the interesting part:

```
health = (0.5·resourceHeadroom + 0.3·spareConcurrency + 0.2·reliability) × freshness
```

Three are weighted and summed because each can be poor without making a node
useless. Freshness **multiplies** because a node that has gone quiet is not
partially healthy — it is *unknown*, and unknown has to decay toward zero.
Summing it in would put a floor under every score, and a machine pinned at 98%
CPU with a full queue would still read as healthy purely because it was
answering the phone.

## Placement: eligibility, then preference

Two stages, in that order, never merged.

**Eligibility** is a set of hard predicates: trust, status, quarantine, drain,
concurrency ceiling, required capabilities, hardware minimums, labels, region,
cost ceiling, pinning. A node either satisfies them or it does not.

**Preference** is a weighted score among the survivors:

| factor | weight | what it measures |
|---|---|---|
| health | 0.30 | the composite above |
| capacity | 0.25 | how much of its concurrency is free |
| latency | 0.15 | smoothed round-trip time |
| hardware | 0.12 | CPU/memory headroom, GPU presence |
| capability | 0.10 | breadth beyond the minimum |
| cost | 0.08 | hourly running cost |

Keeping the stages apart is what makes a placement explainable. A node that
was never eligible is reported as *rejected, with a reason* — not quietly
scored zero so it merely looks like it lost. `POST /distributed/plan` returns
the ranked candidates, the per-factor breakdown and every rejection reason,
without running anything:

```
Chose home-gpu at 0.8123 on health 0.94, capacity 1 (ahead of control-plane by 0.041)
rejected: edge-pi — missing capability PROVIDER:OPENAI
          vps-2   — trust is UNVERIFIED
```

The scheduler's candidate pool deliberately includes nodes it will refuse.
Filtering them out in SQL would remove them from that report, and an operator
asking why their machine is idle would be told nothing at all.

## Transparent worker routing

`DistributedWorkerRouter` installs itself as a callback on the worker runtime
at startup and answers one question per execution: here, or somewhere else?

Returning `null` means "here" and the original in-process path runs untouched.
That covers three cases that genuinely mean the same thing — there is no
fleet, the fleet chose this machine, or the fleet could not choose at all. The
last is a deliberate choice: a scheduling problem degrades to exactly the
behaviour the system had before Phase 4, rather than stalling work that could
have run. A worker *pinned* to an unavailable node is the exception, and
errors rather than silently running elsewhere.

The callback is also what avoids a dependency cycle: the distributed layer
needs the worker runtime to do the executing, and worker execution needs to be
routable, so neither imports the other.

## Tasks outlive attempts

A `DistributedTask` belongs to the organization and survives any particular
machine. An *attempt* on a node is disposable. That distinction is what lets a
node disappear mid-execution without the caller ever learning about it.

The four queues — incoming, active, completed, failed — are the operator's
model; a separate `status` drives the coordinator. Priority is applied at
selection time rather than by keeping four ordered structures, because a
task's priority can change and its position should change with it. Ordering is
priority band first, then age, so nothing starves within a band.

- **Leases.** Assignment takes out a deadline by which the node must report
  back. Nothing asks a node whether it is alive; silence past the deadline is
  answer enough, and the work is placed elsewhere.
- **Retries.** Backoff doubles per attempt, and the failed node is excluded
  from the next placement. The transport's judgement about whether a failure
  was *about the node* or *about the work* is honoured — retrying malformed
  work on a fresh machine just wastes another machine.
- **Migration.** A task keeps its identity, increments a visible counter and
  records where it came from. A task that has bounced four times is a signal
  about the work, not the fleet.
- **Rebalancing.** Only *queued* work moves. Interrupting running work to even
  out a graph costs more than the imbalance does, and the numbers that would
  justify it are the least reliable ones — a node reports its own load.
- **Idempotency keys.** Resubmission is safe. This matters more here than in a
  single process, because a caller that times out genuinely cannot tell
  whether its request arrived.

## Failure is detected by silence

Two silences are watched, and both are treated as loss rather than delay: a
node that stops heartbeating, and a task whose lease runs out. Occasionally
that is wrong and the node was merely slow — `holdsValidLease` is what makes
being wrong harmless, refusing a result from a node whose work has already
been given to someone else.

Three consecutive dispatch failures quarantine a node. One failure is noise;
three in a row is a property of the machine, and continuing to send it work
converts one sick node into a fleet-wide failure rate. Quarantine is a
cooling-off period, not a verdict: it lifts automatically, and the node returns
`DEGRADED` — eligible again, but having to earn its score back.

## Distributed memory

Four scopes, distinguished by *authority* rather than by where bytes live:

| scope | who may write | replicated |
|---|---|---|
| `LOCAL` | one node, about itself | no |
| `SHARED` | any node in the organization | yes |
| `CACHED` | a node's copy of a shared record | no — and always suspect |
| `GLOBAL` | the control plane | read-only to nodes |

Replication is an append-only op log, not a state broadcast. That one choice
gives incremental sync (read past your cursor), offline tolerance (your cursor
stops moving), conflict evidence (the losing write is still there) and
recovery (replay from where you stopped) — without four separate mechanisms.
Recovery is an ordinary pull that happens to return a lot, which keeps the
rarely-exercised path identical to the constantly-exercised one.

Conflicts are resolved by vector clock, in order:

1. Nothing here yet → take it.
2. Incoming descends from ours → fast-forward.
3. Ours descends from incoming → the sender is behind. Marked `SUPERSEDED`,
   not `CONFLICT`: no information was lost.
4. Neither descends from the other → genuine concurrent write. Resolved
   deterministically (version, then timestamp, then node id) with **both**
   versions kept in the log.

Determinism matters more than the specific rule. Node id is the last resort
precisely because it is arbitrary — at that point what matters is not which
write is better but that every node picks the same one.

Reads of a shared record prefer a fresh node-local cache and *skip* a stale
one rather than returning it with a caveat, because a caller that must not act
on old data cannot act on a caveat either.

## Federation: nothing is shared by default

Two organizations that have not exchanged a grant are strangers with no more
access to each other than the public internet has. A grant names its resources
explicitly (`nodes:execute`, `nodes:read`, `memory:read`, `memory:write`,
`knowledge:read`, `workers:invoke`), may be narrowed to specific nodes, carries
a concurrency ceiling so a peer cannot starve the owner, and is revocable at
any moment by either side — effective immediately, not after borrowed work
finishes.

A grant starts `PENDING` and confers nothing until the peer **accepts**, so an
organization cannot be enrolled into a federation it did not agree to. Grants
are one-directional; mutual sharing is two grants, which costs one call and
buys the guarantee that accepting help never obliges you to give any.

`federation_grants` is the one table visible to two tenants, and its RLS policy
says so precisely: readable by both parties, writable only by the issuer.
Access is something you are given, never something you can award yourself.

## Node security

Every message in either direction carries an HMAC-SHA256 signature over
`<timestamp>.<body>`. Against a bearer token that buys three things: the body
cannot be altered in flight, a captured request expires, and the node can
verify the control plane just as the control plane verifies the node.

The timestamp is *inside* the signed material, so a valid signature cannot be
paired with a fresh timestamp to extend its life.

Unlike API keys, node secrets are stored — sealed with AES-256-GCM under
`CREDENTIAL_ENCRYPTION_KEY` — because authentication here is mutual: the
control plane must be able to *produce* a signature, not merely compare one.

Keys are versioned. Rotation issues a new version and leaves the old one
verifying for fifteen minutes, so a node holding in-flight work finishes it and
picks up the new secret on its next heartbeat. Revoking trust is the separate,
immediate action, and revokes every key at once.

The organization comes out of the key, never out of the request body. A node
cannot name the tenant it wants to act on; it can only prove which one it
belongs to.

## The simulated transport is not a mock

`SimulatedNodeTransport` stands in for a machine that is not there, and it is
registered like any other transport rather than hidden behind a test flag.
Every distributed behaviour worth having — placement, migration, lease expiry,
quarantine, sync lag — is invisible on one machine and expensive to demonstrate
on several. This makes them exercisable in-process and *deterministically*: it
simulates latency and fails on command via `metadata.simulate`, so a test can
assert that a node going bad moves its work somewhere else rather than hoping
it would.

Crucially it runs the same handlers a real node would. What is simulated is the
machine and the network — never the work.

The HTTP transport talks to `/nodes/agent/*` in this same codebase, so a node
is not a separate product with its own release cycle: it is this server told to
act as capacity, and the two halves cannot drift apart.

## Testing

```bash
npm test                        # 223 unit tests, 12 suites
node test/phase1-validation.js  # 57 checks
node test/phase2-validation.js  # 58 checks
node test/phase3-validation.js  # 74 checks
node test/phase4-validation.js  # 112 checks
```

Phase 4's suite covers all ten required checks against live Postgres and Redis,
including the negative cases: an unverified node never being scheduled, a
remote node registered without an endpoint, duplicate slugs, unsatisfiable
requirements, work no node can run, wrongly-signed and unsigned and tampered
node requests, an unknown node, a stale sync write, two genuinely concurrent
writes, a pending grant conferring nothing, a grant naming an unknown resource,
a grant that shares nothing, revocation taking effect immediately, and
cross-organization access to every new surface.

Latest run: **112/112 Phase 4, 74/74 Phase 3, 58/58 Phase 2, 57/57 Phase 1,
223/223 unit tests.** 197 documented API operations across 162 paths;
40/40 tenant tables RLS-protected.

## What Phase 4 deliberately does not do

- **No second physical machine in this environment.** The HTTP transport and
  the agent protocol are implemented on both ends and signature verification is
  exercised over real HTTP against the running server, but a genuine
  machine-to-machine deployment across a network has not been run here. Fleet
  orchestration is proven end to end through the simulated transport.
- **No mesh.** Nodes talk to the control plane, not to each other. Peer-to-peer
  gossip would buy resilience at the cost of the single-source-of-truth
  property the rest of PRISM-X depends on.
- **No automatic cross-organization scheduling.** Federation makes a peer's
  nodes *borrowable*; deciding to borrow one is still an explicit act. Silent
  spillover into another organization's hardware is not a behaviour anyone
  should get by accident.
- **No transport-level encryption of its own.** Signing gives integrity and
  authenticity; confidentiality is TLS's job, and terminating it here would
  mean shipping a worse implementation of something the platform already does.
- **No node installer or agent packaging.** Registering a node assumes a
  PRISM-X instance is already running on the machine. Provisioning is an
  operations concern, not an API one.

---
---

# Phase 5 — Learning & Optimization Engine

Phase 5 is where PRISM-X starts learning from itself. Every completed mission
becomes a structured review; reviews accumulate into performance history;
history produces recommendations, patterns and optimized configurations — and
none of it touches production without a person saying yes.

```
   Missions · executions · workflow runs · knowledge · approvals
                              │  read-only
                              ▼
   Mission Review ──► Performance Analytics ──► Pattern Recognition
          │                     │                       │
          └─────────────────────┼───────────────────────┘
                                ▼
                      Recommendation Engine
                                │
                 Worker & Workflow Optimizers
                                │
                       Learning Repository
                                │
                    ── Human Validation ──          ← nothing passes unattended
                                │
                        Production Systems
```

The learning module depends on nothing above it and writes to production
through exactly one method. That direction is deliberate: a system that had to
know it was being observed is one where analysis could change behaviour by
accident.

## Confidence is a primitive, not a column

Every claim the engine makes — a recommendation, a pattern, a worker profile, a
trend — is scored on one shared scale, computed in one place
(`src/learning/confidence.ts`). That matters more than the formula: a system
that learns will produce a claim from three missions and a claim from five
hundred, and if both arrive looking alike, the weak one is indistinguishable
from established knowledge.

```
confidence = volume × quality × recency
```

**Multiplied, not averaged.** Any one factor being near zero should sink the
claim on its own. Three data points are not rescued by being recent and
perfectly consistent — three consistent points are exactly what coincidence
looks like. Averaging would let two strong factors carry a fatal one.

| factor | shape | why |
|---|---|---|
| volume | `n / (n + 12)` | Diminishing returns. The 11th datum is not worthless and the 12th is not everything, so no hard threshold. |
| quality | 1 − coefficient of variation | Scale-free: ±200ms means something different at 300ms than at 30s. |
| recency | decay to a floor of 0.4 | Old evidence discounts but never vanishes; 500 missions last quarter still mean something. |

Scores land in four bands — **ANECDOTAL**, **EMERGING**, **ESTABLISHED**,
**STRONG** — and the band is what the interface leads with, so a thin finding
reads as a question rather than a fact.

### Rates are Wilson lower bounds

Anywhere the system ranks something by a success rate, it ranks by the lower
bound of the Wilson interval rather than the observed proportion.

| record | observed | ranked on |
|---|---|---|
| 3 of 3 | 100% | ~44% |
| 480 of 500 | 96% | ~94% |

Sorted by the raw figure the first outranks the second, which is wrong in a way
that compounds: every recommendation built on that ordering chases noise. The
observed rate is kept alongside as `observedRate` so nothing is hidden.

### "Better" requires the intervals to separate

`comparisonConfidence` returns **exactly zero** when two confidence intervals
overlap — not a small number. "We cannot tell these apart" is a different
statement from "there is a small effect", and rounding the first into the
second is how a learning system talks itself into nonsense. A claim like *"this
worker performs 28% better on Sonnet"* is only ever made when the two arms
genuinely separate.

## Mission reviews

Written automatically when a mission ends, from the mission's own record —
tasks, execution logs, audit trail. Not from asking a model how it went: that
produces fluent prose whose relationship to what happened is unverifiable, and
every downstream analysis would inherit it. Everything here is arithmetic over
rows, so any number in a review traces back to the events that produced it.

Each review carries outcome, success score, timing against estimate, cost
against estimate, human interventions, deduplicated error signatures,
bottlenecks with their share of total task time, missed opportunities and
proposed improvements. One per mission, permanently — it outlives the mission's
tasks and is the unit everything else reasons over.

Missed opportunities are only stated where the record supports them: unused
parallelism (independent tasks that ran in sequence), estimate drift, budget
overrun, retries that were paid for and discarded, model sprawl. No speculative
advice — a review full of plausible suggestions nobody can check is worse than
a short one.

Error messages are collapsed to signatures (ids, timestamps and quantities
stripped) so the same fault is recognisable across missions. Without that,
every failure looks unique and the pattern engine can never notice something
has happened eleven times.

## Performance analytics

Rollups per period for workers, providers, workflows and the organization.
Recomputing a window converges rather than accumulating — the snapshot is keyed
on `(subject, id, period, start)` and rewritten in place.

Trends are **derived** from snapshots, never stored. A trend is a relationship
between measurements; storing it would let it drift out of agreement with the
measurements it summarises. And a trend with too little history reports
`unknown`, not `steady` — those are different claims.

Leaderboards flag rows with too few samples as `rankable: false` rather than
silently ranking them among figures that mean far more.

## Recommendations

Inert data. A recommendation says what it would change and how to put it back,
and until a person accepts it, nothing happens.

- **Rollback is captured at propose time.** A proposal that cannot describe how
  to undo itself is rejected at creation, which rules out the class of change
  nobody can reverse.
- **Priority is impact × confidence.** Ranking on impact alone puts confident
  nonsense at the top of the list, which is where a busy person's attention goes.
- **Re-analysis supersedes.** A nightly analyser would otherwise produce the
  same suggestion every night, and forty identical proposals is a list nobody
  reads.
- **Rejection requires a reason**, and the reason is written into the learning
  repository. A rejected recommendation is evidence about the analyser; "no"
  without a reason teaches nothing.

## Human validation

`RecommendationService.apply()` is the only path from the Learning Engine to
production, and it refuses anything a person has not accepted. The state being
overwritten is read back *immediately before* the write, so a rollback restores
what was actually there rather than what the proposal assumed.

Autopilot exists and is off. Turning it on requires three independent
conditions to hold, because an organization opting into automation has not
thereby consented to changes based on three data points:

1. `learning.autoApply` explicitly enabled in organization settings, **and**
2. the kind is one of the low-risk four (model, provider, limits, memory), **and**
3. confidence ≥ 85%.

Prompt wording, tool grants, workflow structure and knowledge merges never
qualify, at any confidence. A prompt is what an agent *is*; a tool grant widens
what it can do; a merge destroys information. Those are judgements, not numbers.

## Worker profiles

Rebuilt from execution history rather than edited incrementally, so a profile
always agrees with the logs it summarises and a bad update cannot accumulate. A
worker with no history gets **no profile** rather than an empty one — writing
zeros would make a brand-new worker look measured rather than unknown.

The profile records reliability, cost, speed, tool usage and denials, the
prompt-length band that correlated with the best outcomes (labelled as
correlation), recurring failure signatures, and plain-language strengths and
weaknesses. Provider preference is chosen by Wilson lower bound, so a worker is
never moved onto a provider it has barely used on the strength of a lucky
afternoon.

## Workflow optimization

Findings come from step-level run history, not from reading the graph: a step
that *looks* redundant may be load-bearing, and a step that looks essential may
never have changed an outcome in three hundred runs. Detected: repeated
failures, always-skipped steps, bottlenecks, steps producing an identical
result every time, and independent steps running in sequence.

Below five runs the analyser returns nothing at all, because below that every
"finding" is a coincidence with a confident sentence attached.

**A/B testing** compares two versions properly. Allocation is deterministic on
the run id — recomputable from the record afterwards, unlike a random split
nobody stored. A winner is declared only when both arms clear a minimum run
count *and* their intervals separate. An experiment that stops at the first
favourable number is worse than no experiment, because it lends noise the
authority of a measurement.

## Knowledge evolution

Findings, never edits. Merging two documents or deleting a stale one destroys
information, and judging whether two documents say the same thing is exactly
what a similarity score gets wrong at the margins. So the audit records
duplicates, staleness, disuse, missing tags, low confidence and gaps; a human
resolves them; the system's opinion never silently becomes the corpus.

Similarity is Jaccard overlap on tokens — the same measure the Phase 2
retrieval layer uses. An audit judging similarity differently than retrieval
does would flag duplicates retrieval never confuses, and miss the ones it does.

Gaps are found by looking for error signatures that recur across mission
reviews with nothing in the corpus addressing them.

## Pattern recognition

The hard part is not spotting repetition — it is not announcing a discovery
every time two things happen twice. Three defences: a minimum of three
occurrences before anything is recorded, **contradictions counted alongside
occurrences** so a regularity that holds eight times and fails seven is visibly
not one, and a confidence band the interface leads with.

Patterns are keyed on a stable signature and reinforced in place, so something
seen fifty times is one row with a count — the difference between "we have
noticed this repeatedly" and "we have noticed fifty things". A dismissed
pattern is kept rather than deleted: a human saying "that is not real" is
itself evidence, and a detector that can re-propose it next week has learned
nothing.

## The learning repository

Institutional memory, deliberately separate from operational knowledge. Nothing
in it is fed to a worker as context — a system's notes about its own weaknesses
have no business appearing in an answer to a customer's question. It holds
mission reviews, applied optimizations, decisions (including rejections),
benchmarks, A/B outcomes and hand-written lessons, each with confidence and
sample size.

## The dashboard

One screen answering *"what has PRISM-X learned this week?"* It derives nothing
of its own — a dashboard that recalculates its own success rates can disagree
with the engine it reports on, and then nobody knows which number is real.

The `learned` list is the point. Only genuinely new findings go in it:
established patterns, concluded experiments, actionable recommendations, real
movement against the previous window. When nothing recurs often enough to
conclude anything, it says so rather than padding the list with standing facts.

## Testing

```bash
npm test                        # 314 unit tests, 13 suites
node test/phase1-validation.js  # 57 checks
node test/phase2-validation.js  # 58 checks
node test/phase3-validation.js  # 74 checks
node test/phase4-validation.js  # 112 checks
node test/phase5-validation.js  # 86 checks
```

Phase 5's suite covers all ten required checks against live Postgres and Redis,
including the negative cases: a worker with no history getting no profile, a
workflow with too little history yielding no findings, an experiment refusing
to declare a winner early, a second concurrent experiment on one workflow, an
audit that records duplicates without deleting anything, applying without
acceptance, autopilot without opt-in, rejecting without a reason, re-applying
after rollback, and cross-organization access to every new surface.

Latest run: **86/86 Phase 5, 112/112 Phase 4, 74/74 Phase 3, 58/58 Phase 2,
57/57 Phase 1, 314/314 unit tests.** 231 documented API operations across 193
paths; 48/48 tenant tables RLS-protected.

## What Phase 5 deliberately does not do

- **No model in the loop.** Reviews, patterns and recommendations are
  arithmetic over stored rows. An LLM-written post-mortem reads better and
  cannot be checked, and every downstream number would inherit that. The seam
  exists if a later phase wants to *add* model-written narrative on top of the
  measured facts — not in place of them.
- **No semantic similarity.** Knowledge auditing and pattern themes use token
  overlap, not embeddings, so learning does not stop when an API key expires.
  Themes are correspondingly crude and say so.
- **No automatic prompt rewriting.** The engine proposes that a prompt needs
  work and drafts a starting point; the wording stays a human judgement.
- **No cross-organization learning.** Patterns never leave the tenant that
  produced them. Aggregating across customers is a product and privacy decision,
  not an engineering one.
- **No scheduled analysis loop.** Rollups, audits, profiling and detection are
  endpoints. Wiring them to a timer is a one-line change per job, deliberately
  left to whoever decides how often is often enough.

---
---

# Phase 6 — Evolution Engine

Phase 5 concluded things. Phase 6 acts on them: it generates concrete
candidate changes, tests each one against what it would replace, benchmarks
both, and deploys only what measurably wins — behind a boundary it cannot
move.

```
                    Learning Engine
                          │
                          ▼
              Evolution Candidate Generator
                          │
                          ▼
                   Experiment Engine
          ┌───────────────┼───────────────┬──────────────┐
          ▼               ▼               ▼              ▼
       Sandbox         Shadow          Canary           A/B
    (nothing real)  (observed only)  (small share)   (even split)
          └───────────────┼───────────────┴──────────────┘
                          ▼
                   Benchmark Engine  ── nine metrics, per arm
                          │
                          ▼
              ═══ THE PRISM-X CONSTITUTION ═══   ← cannot be moved
                          │
                   Evolution Policy   ← each org's own ceiling
                          │
                          ▼
                     Deployment ──► Monitoring ──► Rollback
                          │
                          ▼
                  Production Intelligence
```

## The Constitution

A self-modifying system needs a boundary it cannot move, or "adaptive"
eventually means "unpredictable". `src/evolution/constitution.ts` holds nine
laws the Evolution Engine may never break — whatever the evidence says,
whatever the confidence, whatever an organization has configured.

| law | it refuses |
|---|---|
| `ORG_PERMISSIONS` | acting beyond the requesting actor's authority |
| `NO_PRIVILEGE_ESCALATION` | touching permissions, roles or scopes; granting tools unapproved |
| `TENANT_ISOLATION` | a subject owned elsewhere, or any foreign org id nested in the change |
| `NO_AUTOMATIC_DELETION` | anything that would destroy history |
| `POLICY_COMPLIANCE` | a change the organization's own policy rejected |
| `HUMAN_CONSENT` | a required approval that is missing, or one recorded by the system |
| `REVERSIBILITY` | no rollback, or a rollback that covers only part of the change |
| `AUDITABILITY` | a deployment that would not be recorded |
| `EVIDENCE_REQUIRED` | a change the benchmark found worse; an unmeasured change nobody approved |

Three properties make this a constraint rather than a comment:

**It lives in code, not the database.** There is no table, no endpoint and no
setting that amends it — the validation suite asserts that `POST
/evolution/constitution` returns 404, and the unit tests assert the array is
deep-frozen and throws on mutation. Changing a law requires a code change, a
review and a deploy, which is exactly the human process the laws protect. A
constitution stored in a row is one the system could evolve, and a
constitution the system can evolve is not one.

**Every law is an executable predicate.** "Never expose another
organization's data" is checked by walking the proposed change recursively for
foreign identifiers — a foreign org id three levels inside a workflow step
config is as dangerous as one at the top, and considerably more likely to be
missed by a reviewer.

**It is checked at a chokepoint evolution cannot route around.**
`DeploymentService.deploy()` is the only path to production, and its first act
is to submit the intent. All nine laws are evaluated rather than stopping at
the first refusal, so an operator sees every reason at once.

Every verdict carries a hash of the law text (`CONSTITUTION_VERSION`), stamped
on every deployment row — so an archive entry from six months ago can be
checked against the constitution that was in force when it was written.

The laws are deliberately about **process integrity** and never about
outcomes. A law saying "only deploy improvements" would be unenforceable and
would give false comfort; these are all decidable from the intent in hand.

### Refusals are recorded

A refused deployment is written as a `Deployment` with status `REFUSED` plus
one `ConstitutionViolation` row per objecting law. An engine repeatedly
proposing illegal changes is a fact about the engine, and that signal only
exists if refusals are kept rather than merely returned.

## Candidates

A candidate is a concrete, testable change — distinct from a Phase 5
recommendation, which is advice for a person. The distinction is what lets them
behave differently: a recommendation waits to be read, a candidate goes into an
experiment and can be **rejected by measurement without anyone looking at it**.
Most candidates should die that way.

Candidates are promoted automatically from recommendations that recur, and the
same change proposed twice reinforces one candidate rather than creating a
second. `proposalCount` makes recurrence visible, which is a real signal: an
opportunity the learning engine keeps rediscovering after new data arrives is
more real than one it found once.

A candidate without a rollback is refused **at creation** — the Constitution
would refuse it at deployment anyway, so accepting it would only defer the
disappointment.

## Experiments

Four modes, ordered by how much of the real system they touch:

| mode | exposure |
|---|---|
| `SANDBOX` | nothing real — the candidate is applied in memory and probed |
| `SHADOW` | runs alongside production; results recorded, never used |
| `CANARY` | a small share of real work |
| `AB` | an even split |

Sandbox is always permitted, because an organization that cannot measure
anything will deploy on a hunch. The rest are gated by policy.

**Both paired modes run every trial against both arms.** Allocation only means
something when real work is being routed; splitting sandbox trials halves the
statistical power for no safety benefit and makes an experiment need twice the
trials to say anything.

The variant runs with the candidate applied **in memory only** —
`WorkerExecutionRequest.overrides` merges the change into a copy of the worker
that is never persisted. A change that had to be written in order to be
measured would have skipped the entire pipeline.

## Benchmarks

Nine metrics per arm — success rate, completion time, quality, cost, tokens,
latency, reliability, user rating, ROI — recorded separately rather than
collapsed into one score. Collapsing early hides the trade-offs that make a
decision worth making: a variant that is faster and worse is a completely
different situation from one that is faster and cheaper, and a single number
reports them identically.

The verdict is decided by **reliability first**, cost and speed second. That
ordering is a claim: a change that makes the system cheaper and quicker while
succeeding less often has not improved it.

Two gates before any comparison: enough trials on both arms, and success rates
that actually separate (Wilson intervals, as everywhere in the platform). If
they overlap, the verdict is `INCONCLUSIVE` — and **inconclusive is not
refutation**. The candidate returns to the queue rather than being rejected,
because a change proposed for a reason the benchmark does not measure is still
perfectly reasonable, and a person may approve it on that basis. A candidate
measured *worse* cannot be approved past, at any confidence.

Reliability is stricter than success rate: succeeding on the second attempt is
a success but not a reliable one. An arm nobody rated reports `userRating:
null` rather than zero — rating is not something a variant should be punished
for lacking.

## Versions

Versions are immutable and never deleted; a new one supersedes its predecessor.
That is what makes rollback a matter of re-activating a row that already exists
rather than reconstructing a past state from diffs — and it is why
`NO_AUTOMATIC_DELETION` can be absolute: nothing in the evolution path ever
needs to remove a row, so a change that would is always a mistake.

A subject has independent lineages per **aspect** — prompt, model, tools,
limits, graph, strategy. They change for different reasons and at different
rates; versioning them together would mean a prompt tweak invalidating a
carefully benchmarked model choice. A change spanning two aspects is refused
rather than assigned to one, because rolling it back would restore half of
what it changed.

A baseline is captured automatically before the first evolution of anything.
Without it, the first change would have nothing to roll back to — the original
configuration would exist only as the live row the deployment is about to
overwrite.

## Deployment

The order of operations is not negotiable:

1. **Read the current state** — immediately before writing, so the rollback
   restores what was actually in production rather than what the candidate
   assumed when it was created.
2. **Ask the policy.**
3. **Submit to the Constitution.**
4. **Write the deployment row** — *before* touching production, so a crash
   mid-write leaves evidence rather than a silent divergence.
5. **Apply**, through the ordinary repositories. There is no privileged path;
   the Evolution Engine is a caller like any other, and tenant scoping applies
   to it exactly as to a person making the same edit.
6. **Watch it.**

Approval and deployment are separate acts, because they answer different
questions: approval says the change is acceptable, deployment says now is the
moment. An organization with a deployment window needs to approve at 3pm and
deploy at 2am.

**Monitoring** decides whether a deployment settles. Once the observed failure
rate crosses the policy's threshold the system rolls back early rather than
waiting out the window — every further minute is damage it could have
prevented. A deployment with no observations settles with `healthy: null`
rather than claiming a verdict nobody measured.

**Rollback** records the restored state as a version of its own rather than
reactivating the old row, so the lineage reads as what actually happened —
deployed, then reverted — instead of pretending the deployment never occurred.

## Policies

The Constitution is the floor nobody can lower; the policy is each
organization's own ceiling. The split matters: "never bypass approval where it
is required" is a law, because a system that could ignore it would make every
other control advisory. *Which* changes require approval is a business
decision a media agency and a hospital should answer differently.

Defaults are conservative and are created on first access rather than
requiring setup, because an organization that has never configured evolution
should not thereby be evolving freely. Prompt and limit tuning are permitted;
provider and model changes are permitted but always need a person; workflow
structure and tool permissions are absent from `allowedKinds` entirely and
have to be opted into.

Policies also cover deployment windows (including ones that wrap midnight — a
real thing operations teams ask for, and reading it as an empty window would
silently block everything), concurrent experiment caps, daily deployment caps,
monitoring duration and the auto-rollback threshold.

A deployment window is not a safety feature in itself — it is a staffing one.
Its purpose is that when something goes wrong, somebody is awake to notice.

## Planning evolution

Planning is the one part of the system that decides how every *other* part gets
used, so improving it compounds — which is also why getting it wrong compounds.
Strategies version like anything else and are compared on the missions they
actually produced, never on how sensible their rules look. Every observation
names the signal it came from, so a suggestion can be checked rather than taken
on faith.

Promoting an unproven strategy over a proven one is refused without `force`:
switching planning on a hunch undoes whatever the previous strategy had earned.

## The dashboard

Refusals and rollbacks get the same prominence as successes. An evolution
dashboard that only shows wins is a marketing page — a candidate killed by
measurement is a change that did not make production worse, and a refusal is
the Constitution doing its job. When nothing improved, the digest says so.

## Testing

```bash
npm test                        # 422 unit tests, 14 suites
node test/phase1-validation.js  # 57 checks
node test/phase2-validation.js  # 58 checks
node test/phase3-validation.js  # 74 checks
node test/phase4-validation.js  # 112 checks
node test/phase5-validation.js  # 86 checks
node test/phase6-validation.js  # 86 checks
```

Phase 6's suite covers all ten required checks plus the Constitution, including
the negative cases: a candidate with no rollback, a second concurrent
experiment, a sandbox that never writes to production, an experiment mode the
policy forbids, deployment outside the window, deployment with evolution
switched off, a high-confidence change of an always-escalated kind, an
unapproved change, a rolled-back deployment, and cross-organization access to
every new surface.

The unit suite asserts each law individually — including that the frozen array
throws on `push`, that a foreign organization id nested three levels deep is
caught, that a partial rollback is refused by name, and that 99% confidence
does not satisfy `HUMAN_CONSENT`.

Latest run at the close of Phase 6: **86/86 Phase 6, 86/86 Phase 5, 112/112
Phase 4, 74/74 Phase 3, 58/58 Phase 2, 57/57 Phase 1, 422/422 unit tests.**

## What Phase 6 deliberately does not do

- **No unattended structural change.** Workflow graphs, tool grants and prompt
  wording never deploy without a person, at any confidence. Those are
  judgements, not numbers.
- **No self-amendment.** The Constitution is the one part of PRISM-X the
  Evolution Engine cannot reach. That is the point, and it is why it is a file
  rather than a table.
- **No genetic search.** Candidates come from measured findings, not from
  mutating configurations and seeing what survives. Random variation would
  produce improvement eventually and would make every intermediate state
  unexplainable.
- **No cross-organization learning transfer.** A strategy proven in one tenant
  is not proposed to another. That is a product and privacy decision, not an
  engineering one.
- **No automatic experiment scheduling.** Candidates queue themselves;
  starting experiments and running trials are explicit calls, because trials
  cost money and how many is worth spending is not the system's decision.


---

# Phase 7 — Platform & Extensibility Ecosystem

Phase 6 let PRISM-X change itself. Phase 7 lets other people change it —
without touching the core. Extensions, contributed workers and tools, a
marketplace, a public API and a developer portal, all of it hosted rather than
merged.

Hosting a stranger's code raises exactly one hard question, and everything here
is an answer to it: **what is this thing allowed to do?**

## Capabilities are the primitive

`src/platform/capabilities.ts` is the spine of the phase, the way
`confidence.ts` was for Phase 5 and `constitution.ts` for Phase 6. It is a
frozen catalogue of sixteen capabilities — `can_execute_missions`,
`can_access_knowledge`, `can_manage_workers`, `can_register_triggers`,
`can_send_notifications`, `can_invoke_external_apis` and ten more — each
carrying a risk level, the RBAC permissions it draws on, and the host methods
it unlocks.

The platform never asks *what kind of thing is this*. It asks *which
capabilities does it hold*. A worker contributed by an extension and a worker
written by the organization are subject to the identical check, because the
check reads a capability set rather than a type.

Three properties make the indirection worth it.

**Capabilities are the only authority.** There is no ambient access and no
wildcard for hosted code. A host method that no capability names is
unreachable: `authorize` returns a denial, and `SandboxService.onModuleInit`
refuses to boot if the implemented surface and the guarded surface disagree.
Adding a method without a capability is a startup failure, not a hole.

**Grants intersect, never union.** An extension's effective authority is what
it requested *and* what the installing principal already holds:

```ts
grant({ requested: manifest.capabilities, holderPermissions: context.permissions })
// → { granted, withheld: [{ capability, missing: [permission] }], risk, reviewRequired }
```

An installer who cannot delete workers cannot install an extension that
deletes workers. The capability is withheld at install time, recorded on the
row, and the extension runs with the smaller set. Privilege cannot be laundered
through an install. The same rule governs contributions — `attenuate` narrows
and never widens — and API keys, whose scopes *are* their permissions.

**Risk drives review.** HIGH and CRITICAL capabilities hold an install at
`PENDING_REVIEW` until a person approves it, and hold a marketplace release out
of the catalogue until a moderator does. The install screen and the governance
queue read the same numbers the sandbox enforces.

The catalogue is frozen code rather than a table for the same reason the
Constitution is: a row can be updated by anything holding a connection, and the
set of things a stranger's code may do is not something that should be editable
at runtime. Its content hash is stamped on every grant, so a grant issued under
an older catalogue is recognisable as such.

## The lifecycle

`install → validate → register → initialize → run → update → disable →
uninstall`, with `migrate`, `quarantine` and `rollback` alongside. Every
transition passes through one method that writes an `ExtensionLifecycleEvent`
before and after the work — which is what makes "the extension is FAILED"
answerable with *which phase failed and why*, months later, without
reproducing it.

A failed `initialize` is not a failed install: the extension exists, its grant
is recorded, and it is inert and repairable. Teardown phases tolerate failure,
because refusing to uninstall something because its own cleanup threw is not a
safety property.

## The sandbox

`SandboxService` is the only place extension code can reach the platform. There
is no object an extension holds that reaches a repository, a Prisma client or
the request context — only a `HostApi` whose 35 methods all funnel through one
`invoke`, which does the same five things regardless of which was called:
capability check, rate limit, timeout, dispatch, audit.

Every call is recorded — allowed, denied, failed or throttled. Denials are the
interesting ones: an extension repeatedly reaching for a capability it lacks is
the signal that it is doing something other than what its listing said. The
audit preview redacts anything that looks like a secret rather than truncating
it, because a truncated token is still a leaked prefix.

Outbound HTTP blocks loopback, link-local, RFC1918 and the cloud metadata
endpoint. It does not resolve DNS, so a hostname pointing at a private address
still gets through — that defence belongs at the egress proxy, where the
resolved address is actually known, and the code says so rather than implying
otherwise.

`can_use_credentials` is narrower than "read secrets": the host injects the
credential into the outbound request after the extension has composed it, on a
header object the extension never holds. It can *use* a stored token; it can
never *read* one.

The rate limiter uses Redis when it is there and a per-process counter when it
is not. `CacheService.increment` returns `null` rather than a number on cache
failure, precisely so the caller can tell "the count is 1" from "there is no
shared counter" — a rate limiter that fails open is not a rate limiter.

## Version management

`analyseUpgrade` compares two manifests and separates two things that are
usually conflated:

- **BLOCKING** — impossible or incoherent. A downgrade, a reinstall of the same
  version, an engine range this platform cannot satisfy, a candidate for a
  different extension.
- **BREAKING** — possible, but it changes the deal the operator agreed to. A
  new capability, a removed contribution, a newly required setting, a config
  type change, a major bump.

Only the second is negotiable. Keeping them apart is what stops "detect
breaking changes" from collapsing into "refuse to ever upgrade". A capability
added in a *patch* release is flagged separately, because that is the exact
shape of a supply-chain attack.

The whole analysis runs on manifests, so it is available before a byte of the
new version has been trusted — which is what "breaking changes must be detected
before installation" actually requires. Consent carries the analysed manifest
with it, so approving days later applies what was shown rather than whatever is
current. Rollback restores from a snapshot taken before the write: manifest,
grant, config and limits together.

The manifest digest is computed over a canonically serialised subset — keys
sorted recursively — because Postgres `jsonb` normalises key order, and hashing
raw `JSON.stringify` output would produce one digest at publish time and a
different one on read. Every signature would have failed to verify. The unit
suite pins this with a jsonb round-trip simulation.

## The marketplace

Ten asset kinds, publisher identities, immutable versions, ratings, advisories.

Releases are signed with **Ed25519**: the platform keeps the public half and
returns the private half exactly once. It can verify a release but can never
produce one — which is the only version of "signed" that means anything, since
a signature the registry could forge attests to nothing beyond the row having
been written.

Breaking changes are computed at publish time by running the installer's own
analysis against the previous release. The publisher's version number is a
claim; the diff is the evidence.

An install checks the listing's status, the publisher's standing, the version's
review state, whether it was yanked, whether a live advisory covers it, and
whether its signature still verifies against a *recomputed* digest — before the
manifest reaches the lifecycle.

## Governance

Publisher verification and suspension, listing suspension and deprecation,
version yanking, review moderation, compatibility testing, security advisories,
and a platform audit log assembled from the decision rows themselves — a log
that can disagree with the decisions it describes is worse than no log.

Advisories are enforced, not just published. `publishAdvisory` quarantines every
affected install across every organization, because the tenants most at risk
are the least likely to be reading the catalogue. It quarantines rather than
uninstalls: taking an extension away is the organization's decision once they
can see why. `QUARANTINED` is deliberately distinct from `DISABLED`, so
re-enabling requires addressing the reason rather than clicking the same button
again.

Deprecation is *not* suspension. A deprecated asset stays installable, because
pulling it out from under everyone mid-migration is how a deprecation becomes an
outage.

## Two RLS shapes

Phase 7 is the first phase whose data is not entirely tenant-private, so the
migration carries two policy shapes:

- **Tenant tables** (8) — the usual contract: no organization context means no
  rows, `WITH CHECK` stops a constrained session writing rows it does not own.
- **Catalogue tables** (5) — publishers, listings, versions and advisories are
  read by everyone by design; a marketplace partitioned by tenant is not a
  marketplace. They get separate SELECT and INSERT/UPDATE/DELETE policies:
  readable by all, writable only by the owning organization. One combined
  `USING` clause cannot express that — it would hide other publishers' rows
  from the catalogue entirely.

Version ownership is derived from the parent listing rather than duplicated onto
the row, so a listing changing hands cannot leave versions behind that the
previous owner can still rewrite. `governance_reviews` gets a read policy and
deliberately no write policies: a moderation decision is not the publisher's to
write, and the publisher is the only organization a constrained session could
claim to be.

Verified against a constrained `prismx_tenant` session: catalogue readable
across tenants, another organization's listing not updatable, forged ownership
rejected by policy, tenant tables invisible.

## The SDK and the developer portal

`src/platform/sdk.ts` imports no service, no repository and no Prisma type. An
author can read that one file and know exactly what they get; the platform can
rewrite everything behind it without breaking an extension.

The portal's documentation is *generated* from the same constants the runtime
enforces — the capability catalogue, the guarded surface, the manifest schema,
the limits. A developer reading "these are the capabilities" is reading the
actual catalogue, so the docs cannot drift. The manifest reference ships an
example that is validated on the way out, so a change to the validator that
would break it fails in the test run rather than in someone's editor.

API keys now authenticate. `ApiKeyService` installs a resolver on `AuthService`
through the same callback seam the approvals and node-routing paths use, and
the guard accepts `x-api-key` where there is no bearer token. A key's scopes are
its permissions — the same intersection rule, applied to a credential that
travels outside the product.

## What the loader does, and does not, do

PRISM-X ships one `IExtensionLoader`: an in-process loader that synthesises a
module from the manifest rather than executing publisher-supplied code. This is
the same seam the provider, connector and node-transport layers use, for the
same reason — the interesting behaviour to get right first is the platform's.

Everything above the loader is real and exercised end to end against it: the
grant, the sandbox, the lifecycle, the audit trail, the upgrade analysis, the
signing, the governance. Running a publisher's actual code is a second
implementation of one interface — an isolate, a container, a remote runtime —
not a change to anything above it.

## Testing

```bash
npm test                        # 477 unit tests, 16 suites
node test/phase1-validation.js  # 57 checks
node test/phase2-validation.js  # 58 checks
node test/phase3-validation.js  # 74 checks
node test/phase4-validation.js  # 112 checks
node test/phase5-validation.js  # 86 checks
node test/phase6-validation.js  # 86 checks
node test/phase7-validation.js  # 84 checks
```

Phase 7's suite covers all ten required checks, including the negative cases: an
invalid manifest, a capability outside the catalogue, an extension enabled while
its grant is pending, a contribution asking for authority its extension was
refused, an installer lending authority it does not hold, a downgrade, a
capability added in a patch release, an engine range the platform cannot
satisfy, a republished version, an install while a review is open, an install
covered by an advisory, a quarantined extension re-enabled, an invalid API key,
and a tool whose extension has been uninstalled.

Latest run: **84/84 Phase 7, 86/86 Phase 6, 86/86 Phase 5, 112/112 Phase 4,
74/74 Phase 3, 58/58 Phase 2, 57/57 Phase 1, 477/477 unit tests.** 325
documented API operations across 274 paths; 69 tables RLS-protected; migrations
verified from an empty database.

## What Phase 7 deliberately does not do

- **No arbitrary code execution.** The shipped loader synthesises behaviour
  from the manifest. Isolation primitives — an isolate, a container, a
  seccomp profile — are a loader implementation, and shipping the enforcement
  layer first is the right order.
- **No DNS-level SSRF defence.** Literal private addresses are blocked; a
  hostname resolving to one is not. That check belongs where the resolved
  address is known.
- **No OAuth.** API keys authenticate the public API. OAuth is a Phase 8
  concern alongside the rest of the production surface.
- **No cross-organization capability inference.** An extension trusted in one
  tenant earns nothing in another. Verification is a publisher property, not a
  transfer of trust between installs.
- **No automatic upgrades.** A non-breaking upgrade applies when asked for. The
  platform never reaches out for a new version on its own — an unattended
  upgrade of third-party code is the supply-chain risk, not the mitigation.
