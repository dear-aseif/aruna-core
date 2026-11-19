# Product — Aruna Core

## What this is

Aruna Core is a multi-tenant AI agent skeleton for small businesses (UMKM).
One shared core serves every tenant; a tenant's business is described by a
**Playbook** (catalog, schedule, templates, thresholds), and vertical behaviour
comes from **packs**. Owners talk to the assistant in chat; the assistant works
through a task pipeline and never acts externally or on money without passing
a Checker and, where required, explicit owner approval.

## Users

- **Owner** — the small-business owner/operator. Mobile-first, works from the
  phone, approves or rejects agent drafts, edits catalog/stock/settings.
- **Operator** — the platform side (PahamAI). Provisions tenants, verifies data
  exports, deactivates tenants. Never a tenant's day-to-day user.

## Proof applications in this repo

1. **Denana (Services Pack)** — a women-only facial treatment studio in Bima:
   treatments, bookings with overlap protection, a public intake page.
2. **Toko Seragam (Retail Pack)** — a school-uniform shop: product variants,
   stock with low-stock flagging, purchase orders, goods receipt, supplier
   follow-up drafts.

Both run on the same core in the same deployment, as two concurrent tenants.

## Product principles

- Business-first: screens and flows serve the owner's daily work, not the AI.
- The assistant's name is configurable per tenant (default: Aruna).
- Facts shown to the owner come from records and queries; models phrase, they
  do not invent numbers, names, or statuses.
- A tenant can always take their data out: a complete export exists before any
  deactivation, and deletion is a separate, later, explicit operator action.

## Out of scope for this build

Live external channels (WhatsApp/social sending), payment execution or
integration, offline sync (design-level only), voice, social-media management,
multi-business owner accounts, self-serve signup, a polished BYO-key UI, and
generative images.
