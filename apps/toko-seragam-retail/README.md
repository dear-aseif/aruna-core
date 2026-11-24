# Application 2: Toko Seragam (Retail)

## What it is

A back-office assistant for a school-uniform shop: product variants (size and
type), stock with low-stock flagging, purchase orders, goods receipt, and
supplier follow-up drafts. The owner approves every outgoing draft; nothing is
sent on a live channel in this build.

## Tenant

Toko Seragam, a synthetic tenant seeded from `playbooks/toko-seragam.json`
(pack: `retail`).

## Core modules it builds on

- Tenancy and Data Access Layer: every pack table carries `tenant_id` with RLS.
- Task pipeline: stock flags and follow-ups run Queued to Done with audit entries.
- Checker and Approval Gate: follow-up drafts are checked, then approved by the
  owner against the exact checked revision.
- Model Gateway: drafts are phrased through the gateway; facts come from records.
- Briefings: the pack adds a current-stock-flags section.
- Export: the pack registers its entities for the owner data export.

## Status

Scaffold only. The pack is built in **group 12** of the spec
(`.kiro/specs/aruna-core/tasks.md`): entities and migrations, catalog and stock
screens, stock routine, supplier follow-up flow, goods receipt, briefing
section, and pack tests. Its Playbook, pack screens, domain code and tests will
live in this folder (the Playbook moves here from `playbooks/toko-seragam.json`
in task 12.1).

## Demo on the live core

- URL: https://aruna.pahamai.com
- Seeded owner account: `owner@toko-seragam.example`
- The password is held by the founder and given to evaluators through the
  submission form only. It is not stored in this repository.

The core (sign-in, board, chat, briefings, EN/ID) is live now. Retail screens
appear once group 12 is built.
