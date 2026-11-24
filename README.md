# Aruna Core

A multi-tenant AI agent skeleton for small businesses: one shared core — tenancy, a
task pipeline with human approval, a two-layer checker, an append-only audit log, and
a provider-agnostic model gateway — proven by two working vertical packs.

Built as a **Kiroween 2026** entry (Skeleton Crew). Specification first: the full
spec lives in [`/.kiro/specs/aruna-core/`](.kiro/specs/aruna-core/) and is the
source of truth for everything this codebase does.

## Live demo

https://aruna.pahamai.com

## Map: one core, two applications

| Part | Where | What |
|---|---|---|
| Core | [`src/`](src/), [`db/`](db/) | Tenancy, task pipeline, Checker + Approval, audit log, Model Gateway, briefings, export |
| App 1: Denana (Services) | [`apps/denana-services/`](apps/denana-services/) | Women-only facial studio in Bima: treatments, bookings, public intake page |
| App 2: Toko Seragam (Retail) | [`apps/toko-seragam-retail/`](apps/toko-seragam-retail/) | School-uniform shop: variants, stock, purchase orders, goods receipt |

Both applications run on the same core as two concurrent tenants. Each folder
README says how to demo it.

## Non-negotiable rules baked into the core

- Every business record carries a `tenant_id`; the Data Access Layer is the only
  data path, and PostgreSQL Row-Level Security enforces isolation structurally.
- No payment state ever changes on a model's say-so — deterministic rules plus an
  explicit owner approval event only.
- Every agent action passes a deterministic-first Checker and, for external or
  money-adjacent actions, a human Approval Gate bound to the exact checked revision.
- The audit log is append-only and written in the same transaction as the change
  it records.

## Stack

Next.js (App Router, TypeScript) · PostgreSQL on AWS Lightsail (managed, RLS) ·
Auth.js credentials auth with database sessions · Amazon Bedrock behind a
provider-agnostic Model Gateway · hosted on AWS Lightsail.

## Status

Spec: requirements v1 · design v1.4 · tasks v1.2. The core is deployed live
(24 Nov 2026). The application packs land in group 12 (Retail) and group 13
(Services); until then the two application folders are scaffolds.

## Licence

[MIT](LICENSE)
