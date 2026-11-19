# Aruna Core

A multi-tenant AI agent skeleton for small businesses: one shared core — tenancy, a
task pipeline with human approval, a two-layer checker, an append-only audit log, and
a provider-agnostic model gateway — proven by two working vertical packs.

Built as a **Kiroween 2026** entry (Skeleton Crew). Specification first: the full
spec lives in [`/.kiro/specs/aruna-core/`](.kiro/specs/aruna-core/) and is the
source of truth for everything this codebase does.

## Proof applications (one codebase, two tenants)

- **Denana** — services pack: a women-only facial treatment studio (treatments,
  bookings, a public intake page).
- **Toko Seragam** — retail pack: a school-uniform shop (product variants, stock,
  purchase orders, goods receipt).

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

Spec phase complete and amended after an independent model review
(requirements v1 · design v1.4 · tasks v1.1). Build in progress.

## Licence

[MIT](LICENSE)
