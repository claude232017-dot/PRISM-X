# PRISM-X Backend — Phases 1–3
### Core Foundation · Intelligence & Execution · Automation & Integration

The production backend for the PRISM-X Intelligence Operating System. It is a
standalone service: it holds all business logic, owns the data model, and is
consumed over HTTP. The existing browser app, and any future desktop, mobile or
third-party client, are peers talking to the same API.

```
Clients (web · desktop · mobile · public API)
        │  REST + JWT
        ▼
  NestJS application
        ├── Guards (JWT → RBAC)          ── every route locked by default
        ├── Feature modules              ── controller · service · DTOs
        ├── Repository layer             ── the ONLY place that queries the DB
        ├── Event bus                    ── durable domain events
        └── Provider registry            ── vendor-neutral intelligence seam
        │
        ▼
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
└── health/          liveness + dependency checks
```

Each feature module owns its controller, service, DTOs and validation. Business
logic never leaves its module, and never talks to Prisma directly.

---

## Authorization

Four seeded system roles over 38 `resource:action` permissions:

| Role | Scope |
|---|---|
| `OWNER` | Everything, including deleting the organization |
| `ADMIN` | Everything except deleting the organization |
| `OPERATOR` | Full CRUD on workers, missions and knowledge; read-only elsewhere |
| `VIEWER` | Read-only |

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
