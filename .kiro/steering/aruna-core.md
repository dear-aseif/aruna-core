# Aruna Core — Steering

## Source of truth

The specification in `/.kiro/specs/aruna-core/` (requirements.md, design.md,
tasks.md) governs this codebase. Implement to the spec. If the spec is silent or
ambiguous on a decision that matters, STOP and flag the gap instead of inventing
a decision.

## Locked decisions (do not relitigate)

- Stack: Next.js (App Router, TypeScript) PWA; PostgreSQL on AWS Lightsail
  managed database with Row-Level Security; hosting on AWS Lightsail with system
  cron; Auth.js credentials auth, database sessions, argon2id password hashes.
- Models are reached only through the provider-agnostic Model Gateway
  (Amazon Bedrock adapter by default). Agent code never imports a provider SDK.
- Build account context: this repository is a Kiroween 2026 (Skeleton Crew)
  entry; keep the `/.kiro` trail complete and honest.

## Hard rules

1. **Tenancy.** Every business record carries `tenant_id`. The Data Access Layer
   is the only data path. Tenant context is bound with `SET LOCAL
   app.tenant_id` inside the same transaction that runs the queries; a missing
   tenant context fails closed. Cross-tenant reads and writes are refused and
   audited.
2. **Payment authority (C3).** No payment state ever changes on a model's
   say-so. Only deterministic rules plus an explicit owner approval event may
   move it. Refunds are always human decisions.
3. **Pipeline discipline.** Every agent action flows Queued → Working →
   In Review → Pending Approval → Done/Rejected/Expired, plus Failed as the
   visible terminal error state. Nothing executable reaches the owner without
   passing the Checker; approvals bind to the immutable checked revision and
   execute atomically and idempotently.
4. **Audit.** Append-only, written in the same transaction as the change it
   records, with a stable actor identity on every entry.
5. **API-first.** All business logic lives behind the server boundary; the web
   UI is only one client. Every UI action maps to a server operation.
6. **Test-first.** Test sub-tasks in tasks.md are REQUIRED, not optional. Write
   and run the tests for a task before presenting it as done.
7. **Data.** Seed and demo data are synthetic only. No real customer data, no
   secrets or credentials in the repository, ever.

## Scope discipline

Anything the requirements list as out of scope stays out (live external
channels, payment execution, offline sync beyond the design note, voice,
social-media management, multi-business accounts, self-serve signup, polished
BYO-key UI, generative images). Do not add features the spec does not ask for.
