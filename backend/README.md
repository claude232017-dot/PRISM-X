# PRISM-X Backend — Phase 1 (Core Foundation)

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

Phase 1 registers **no** vendor adapters. Providers can be configured, stored
and inspected; asking for an adapter raises `ProviderNotImplementedError`, and
`POST /providers/:id/health-check` reports `healthy: false` with an explanation
rather than a false success. Adding OpenAI or Anthropic later is one adapter and
one `registry.register()` call.

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

## What Phase 1 deliberately does not do

- **No vendor AI adapters.** The interface is here; the implementations are
  Phase 2.
- **No mission execution.** Queues, retry policy and observability are live, and
  the processor acknowledges and logs jobs. Driving tasks through a provider is
  Phase 2.
- **No mail transport.** Notifications resolve to a logging channel that states
  exactly what it would have sent, rather than silently dropping messages.
