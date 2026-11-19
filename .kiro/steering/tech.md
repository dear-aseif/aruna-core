# Tech — Aruna Core

## Stack (locked)

- **Framework:** Next.js (App Router) with TypeScript, shipped as a PWA.
- **Database:** PostgreSQL on AWS Lightsail managed database. Row-Level
  Security is enabled and forced; tenant isolation is structural, not
  app-level filtering.
- **Auth:** Auth.js credentials provider, database sessions, argon2id password
  hashes. Accounts are provisioned (seeded) — no self-serve signup.
- **Hosting:** AWS Lightsail instance; system cron drives the per-minute
  expiry sweep and scheduled briefings. Cron endpoints are not publicly
  invocable (secret header / localhost only).
- **Models:** provider-agnostic Model Gateway; Amazon Bedrock adapter is the
  default. Every gateway call is associated with a task or a named routine
  context and is usage-audited per tenant.

## Architecture constraints

- **API-first.** All business logic lives behind the server boundary; the web
  UI is only one client. Every UI action maps to a server operation.
- **Data Access Layer is the only data path.** Tenant context is bound per
  transaction (`SET LOCAL app.tenant_id`); no context = fail closed. Database
  roles: separate migration owner; the runtime role is a non-owner without
  BYPASSRLS.
- **Task pipeline is enforced in one module.** States: Queued, Working,
  In Review, Pending Approval, Done, Rejected, Expired, Failed. Transitions
  write audit entries in the same transaction.
- **Checker is deterministic-first.** Code rules validate structure, amounts,
  recipients, and cross-record consistency; model review may flag, never
  override a deterministic failure. Critical facts are rendered from verified
  fields via templates.
- **Approvals bind to the immutable checked revision** and execute atomically
  and idempotently; expiry decisions use database time.
- **Audit log is append-only** (grants deny UPDATE/DELETE/TRUNCATE to
  application roles; no cascading deletes into it) and records a stable actor
  identity per entry.

## Conventions

- TypeScript strict; server code and UI code clearly separated by the API
  boundary.
- Tests are required, not optional: unit/property-style tests for rules and
  arithmetic, integration tests for tenant isolation and the pipeline, gateway
  tests against a test-only fake adapter, and a phone-viewport smoke test.
- Environment variables and DB connection roles follow the list in design.md
  §Technology decisions. No secrets in the repository; `.env.example` documents
  names only.
- Seed data is synthetic only.
