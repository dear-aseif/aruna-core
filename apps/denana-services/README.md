# Application 1: Denana (Services)

## What it is

A booking assistant for a women-only facial treatment studio in Bima:
treatments with duration and price, bookings with overlap protection, and a
public intake page where clients request a slot. The owner approves each
booking confirmation.

## Tenant

Denana, a synthetic tenant seeded from `playbooks/denana.json`
(pack: `services`).

## Core modules it builds on

- Tenancy and Data Access Layer: every pack table carries `tenant_id` with RLS.
- Task pipeline: each booking request is a task from Queued to Done/Rejected.
- Checker and Approval Gate: the deterministic overlap rule runs before
  Pending Approval; approval binds to the checked revision.
- Model Gateway: confirmation drafts are phrased through the gateway; facts
  come from records.
- Briefings: the pack adds today's confirmed bookings and pending requests.
- Export: the pack registers its entities for the owner data export.

## Status

Scaffold only. The pack is built in **group 13** of the spec
(`.kiro/specs/aruna-core/tasks.md`): entities and migrations, public intake page
and "simulate request" action, confirmation draft and overlap rule, approval
outcomes, briefing section, and pack tests. Its Playbook, pack screens
(including the intake page logic), domain code and tests will live in this
folder (the Playbook moves here from `playbooks/denana.json` in task 13.1).

## Demo on the live core

- URL: https://aruna.pahamai.com
- Seeded owner account: `owner@denana.example`
- The password is held by the founder and given to evaluators through the
  submission form only. It is not stored in this repository.

The core (sign-in, board, chat, briefings, EN/ID) is live now. Services screens
appear once group 13 is built.
