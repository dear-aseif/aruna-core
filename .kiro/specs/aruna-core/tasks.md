# Implementation Plan — Aruna Core

**Project:** Aruna Core — one AI agent skeleton for small businesses, proven by two applications
**Competition:** Kiroween 2026 (Devpost) · Category: **Skeleton Crew** · Bonus claimed: Best Startup Project
**Status:** APPROVED v1.1 — Gate 3 PASSED 19 Nov 2026 (founder verdict: PASS all). Amended 19 Nov 2026 to v1.1 following the GPT-6.1 Sol spec-review evaluation (founder PASS on the amendment list); status remains APPROVED (Gate 3). Spec phase S0 complete: requirements, design, and tasks are all locked.
**Companion documents:** `requirements.md` (Gate 1: PASSED) · `design.md` v1.4 (Gate 2: PASSED)

Build order follows the stage plan: **core foundation → Retail Pack (Toko Seragam) → Services Pack (Denana) → deployment**. The Retail Pack is built before the Services Pack because its input data is already complete, while Denana's final configuration depends on the pending discovery session (results due by 22 Nov 2026; see task 13.1).

House rule (deviating deliberately from the Kiro convention of marking tests optional): test sub-tasks in this plan are **required**, per the founder's test-first discipline. Checkpoints are hard stops: work pauses, tests must pass, and the founder reviews before the next group starts. Within each group, the test sub-tasks are written before the implementation they cover — the test-first order applies per group, not only at checkpoints.

Precedence and data rules (v1.1): the founder decisions recorded in the design close the open items left by the requirements — where the design and a requirements open item appear to differ, the design governs; `requirements.md` itself stays frozen and is never edited by an amendment. All seed data is **synthetic-only**: realistic business shapes with invented names, catalogs, and histories — never real customer data (constraint C4).

All build sessions run under one Kiro sign-in (Google sign-in, 4,000 Kiroween credits) with the founder operating Kiro and reviewing each checkpoint (guided-manual pattern).

---

## Tasks

- [ ] 1. Repository and project scaffold
  - [ ] 1.1 Create the public GitHub repository `aruna-core` under the MIT licence; commit `/.kiro/specs/aruna-core/` containing `requirements.md`, `design.md`, and this `tasks.md` from the first commit, plus initial steering notes capturing the design's binding rules (API-first client separation, tenant isolation, safety mandate C3)
  - [ ] 1.2 Scaffold the Next.js application (App Router, TypeScript), Tailwind, PWA manifest and install metadata, environment configuration, and test tooling (Vitest, Playwright)
  - [ ] 1.3 Provision the Lightsail managed PostgreSQL database; wire database connections with per-session tenant variable support (`SET LOCAL app.tenant_id`); set up SQL migrations
  - _Requirements: C1, 11.1_

- [ ] 2. Tenant foundation, auth, and Playbook service
  - [ ] 2.1 Create core migrations: `tenants`, `profiles`, `playbooks`, `settings`, `audit_log` — every business table carries `tenant_id`; Row-Level Security policies keyed to the session tenant variable; database grants deny UPDATE/DELETE on `audit_log`. The remaining core migrations are allocated where their features are built: `tasks` in 4.2, `threads` and `messages` in 8.1, `briefings` in 10.2
  - [ ] 2.2 Implement application-level credentials auth (Auth.js): owner login, profile↔tenant binding (one tenant per owner in this slice), server-side tenant resolution from the profile — never from client parameters
  - [ ] 2.3 Implement the Data Access Layer: tenant-scoped query helpers used by all server code; cross-tenant references are refused and recorded as `security.cross_tenant_attempt` audit entries
  - [ ] 2.4 Implement the Playbook service: JSON schema validation (core schema + pack fragments), activation that refuses incomplete Playbooks with the exact missing-field list, runtime reads of catalog/hours/thresholds/templates/pack from the active Playbook (the Playbook seeds the assistant name; after activation the name lives in settings — task 8.1). Define and register **both packs' schema fragments here** (Retail: catalog with variants, low-stock threshold, follow-up template; Services: treatment catalog with duration and price, hours, confirmation template) so pack registration and minimum seed exist before activation; the packs' entity migrations and workflows stay in groups 12 and 13
  - [ ] 2.5 Write the two Playbook files (`/playbooks/denana.json`, `/playbooks/toko-seragam.json`) and the seed loader that creates both tenants from them. Denana's Playbook is seeded now with the minimum business shape already known (women-only facial treatments and bookings: treatment names, durations, prices, and hours in synthetic form shaped on the real business); its final configuration is a dated dependency handled in task 13.1, not a condition for this seed. All seed content is synthetic-only (C4)
  - [ ] 2.6 Write tenant-isolation tests (two seeded tenants, cross-access refused and audited) and Playbook-validation tests
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.3, 2.4 — Properties 1, 8_

- [ ] 3. Checkpoint — foundation verified
  - [ ] Ensure all tests pass; verify at the **service level** (through tests/scripts against the Playbook service and the Data Access Layer — the workspace UI only arrives in group 9) that switching a tenant's active Playbook changes the business data the services return (business name, catalog, assistant name) with no code change. Ask the founder if questions arise.

- [ ] 4. Task pipeline and audit trail
  - [ ] 4.1 Implement the audit service: append-only writes for agent actions, Checker results, approval decisions, exports, and security events; per-task chronological history query
  - [ ] 4.2 Create the `tasks` migration (tenant-scoped, RLS) and implement the task state machine as the single module allowed to change task status (Queued → Working → In Review → Pending Approval → Done / Rejected / Expired / **Failed**), with every transition audited (actor, from/to, timestamp). Failed is a terminal status, visible on the board, entered from Working or In Review when a provider/model call fails; a failed task returns to Queued only through an explicit owner retry action, which is audited
  - [ ] 4.3 Implement approval expiry: `approval_expires_at` set on entering Pending Approval (default 15 minutes, from Playbook config); a per-minute sweep (system cron) plus a lazy check on read/action mark overdue tasks Expired and cancel their actions
  - [ ] 4.4 Implement task operations for all origins (routine, maestro, direct, intake): create, list by tenant and status, detail with check and approval history
  - [ ] 4.5 Write state-machine tests (legal/illegal transitions, including transitions into Failed and owner-only retry), expiry tests covering the deadline boundary (just before, exactly at, and just after `approval_expires_at`), an approve-versus-sweep race test (an approval and the expiry sweep acting on the same task concurrently — exactly one outcome wins and no action executes after Expired), and an audit-atomicity fault-injection test (forcing the audit write to fail rolls back the business mutation, and forcing the mutation to fail leaves no success audit entry)
  - _Requirements: 3.3, 5.4, 6.1, 6.2, 6.3 — Properties 4, 5_

- [ ] 5. Model Gateway
  - [ ] 5.1 Implement the gateway interface from the design (§2.7); agent code imports only the gateway, never a provider SDK
  - [ ] 5.2 Implement the Amazon Bedrock adapter as the default; per-tenant provider/model configuration in `settings` with the project default
  - [ ] 5.3 Record every call as a `model.usage` audit entry (tenant, task, provider, model, tokens when reported). Every call must carry an association — a task ID, or a named routine context (e.g. briefing generation) that still records tenant and context; the tenant is derived from the trusted server context, never from call input. Enforce a per-call timeout. Accounting is written for successful calls, provider errors, and malformed outputs alike; provider failure, timeout, or malformed output fails the task with a visible error state (Failed) and no fabricated result
  - [ ] 5.4 Implement the test-only fake adapter (never wired into a deployed configuration) and gateway tests: a forced-failure test, a timeout test, a call-association test (a call without a task or named routine association is refused), and accounting tests proving a `model.usage` entry exists for success, provider-error, and malformed-output calls
  - _Requirements: 10.1, 10.2, 10.3, 10.4 — Property 10_

- [ ] 6. Checker and Approval Gate
  - [ ] 6.1 Implement the deterministic Checker framework: a per-pack rule registry; rules are pure functions over source records (required fields, number equality, recipient match); a failed check writes the specific anomaly to the task and returns it to Working
  - [ ] 6.2 Implement the model-review step (via the gateway) that runs after deterministic checks pass and can only flag, never override a deterministic failure
  - [ ] 6.3 Implement the approval-action interface and test handlers first (the real pack handlers land with groups 12 and 13): approve/reject with decider and timestamp audited. Approval is bound to the exact immutable revision of the draft that passed the Checker: on approval, that revision executes — atomically and idempotently, so approving twice executes once, and any change to the draft invalidates the earlier check and approval. Gated actions built in this slice: booking confirmation, goods-receipt recording, and follow-up sendable marking. Enforce that payment states change only via deterministic rules plus an explicit owner approval event — no model path exists
  - [ ] 6.4 Write Checker tests (each rule passes/fails on crafted records), a Property 2 bypass test (attempting to execute a gated action through a direct server path that skips the Checker and Approval Gate is refused), an execution-binding test (double approval executes once; a draft changed after checking cannot be approved on the old check), and a payment-authority test proving the deterministic rule is what authorizes a payment-state change: a model output accompanied by an approval event still cannot change a payment state when the deterministic rule fails, and no model output can precede a payment-state change without an approval event
  - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, C3 — Properties 2, 3_

- [ ] 7. Checkpoint — safety core verified
  - [ ] Ensure all tests pass; run the Tier-3-style abuse cases by hand (fake payment claim, discount injection, cross-tenant reference) and confirm the pipeline refuses or escalates each one. Ask the founder if questions arise.

- [ ] 8. Agents and chat
  - [ ] 8.1 Create the `threads` and `messages` migrations (tenant-scoped, RLS) and implement threads and messages: one Maestro thread and one thread per active specialist per tenant; the assistant display name comes from settings and a rename takes effect immediately in chat, briefings, and the workspace
  - [ ] 8.2 Implement the agent runtime: a command in any thread creates or updates a task and is audited; agent outputs are schema-validated structured drafts attached to their task
  - [ ] 8.3 Implement Maestro live-data answers: status questions are answered through typed server query functions over live tasks and audit entries
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 9. Owner workspace UI
  - [ ] 9.1 Build the single navigation shell (Board, Chat, Briefings, pack screens, Settings); only Playbook-driven content differs between tenants
  - [ ] 9.2 Build the task board: pipeline columns on wide viewports; per-status stacked view with filter chips on phone viewports; approve, reject, chat, and briefing actions all completable from the phone viewport
  - [ ] 9.3 Build task cards showing responsible agent, origin, status, and check/approval history; task detail shows the audit trail
  - [ ] 9.4 Build chat UI, briefings UI (today + archive), and settings UI (assistant rename, Playbook view, model configuration, export trigger — the owner triggers an export of their own tenant's data here; verification and deactivation are operator-only, task 10.4)
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 10. Briefing routine and data export
  - [ ] 10.1 Implement the routine engine: per-tenant schedule from the Playbook, run by system cron on the Lightsail instance; pack briefing sections plug into one shared routine
  - [ ] 10.2 Create the `briefings` migration (tenant-scoped, RLS) and implement briefing generation from records only (yesterday's outcomes, today's pack facts, pending approvals always listed explicitly), with archive storage and reopening from the workspace
  - [ ] 10.3 Implement the export service: per-tenant archive (JSON, CSV for flat entities) covering the full entity list of design §2.9 — playbook (including version), catalog, treatments, variants, stock, suppliers, purchase orders and their lines, bookings, tasks, threads, messages, briefings, settings, business profile, and the full audit log, for every pack that holds data; credentials and auth secrets are never exported. The owner can trigger an export of their own tenant's data at any time (task 9.4); the export itself is audited with entity counts
  - [ ] 10.4 Implement tenant deactivation following the fixed order (export → verify → deactivate, data retained read-only). Verification and deactivation are **operator-only**. The archive carries a cutoff timestamp and an entity-count manifest; any change after the cutoff requires a fresh export and verification before deactivation may proceed. Deactivation revokes active sessions, expires pending approvals, and blocks further writes for that tenant from old sessions, the public intake page, and routines — tenant status is checked on every server operation
  - [ ] 10.5 Write briefing-fidelity tests with per-fact assertions (each fact stated in a briefing is asserted against its source record — not merely that the source facts exist; pending approvals always present), an export-completeness test against the design §2.9 entity list (including threads and messages), a cutoff test (a change after the export cutoff blocks deactivation until a fresh export and verification), and deactivation-enforcement tests (after deactivation, writes via an old session, the public intake page, and a routine are all refused)
  - _Requirements: 1.4, 9.1, 9.2, 9.3, 9.4 — Property 9_

- [ ] 11. Checkpoint — core complete
  - [ ] Ensure all tests pass; the skeleton runs end to end with both tenants seeded (no pack flows yet). Ask the founder if questions arise.

- [ ] 12. Retail Pack — Toko Seragam
  - [ ] 12.1 Register the pack: entities and migrations for `products`, `variants`, `suppliers`, `purchase_orders`, `po_lines` (all tenant-scoped with RLS), using the pack's Playbook schema fragment defined and registered in task 2.4
  - [ ] 12.2 Build catalog and stock screens (owner-editable); the stock service applies every stock change with before/after audit entries
  - [ ] 12.3 Implement the stock routine: variants at or below the Playbook threshold are flagged in a Stock Task
  - [ ] 12.4 Implement the supplier follow-up flow: draft generated from the Playbook template with item, quantity, and PO reference taken from records → Checker → Approval Gate → marked sendable (recorded in-app; no live channel in this slice). If the flagged item has no purchase order or supplier on record, no reference is invented: the task surfaces an anomaly asking the owner to select the supplier/PO (or supply the missing data) before any draft is produced
  - [ ] 12.5 Implement goods receipt: each receipt is recorded as an immutable, uniquely identified receipt event carrying the newly received quantity (a delta); recording it updates stock by exactly that quantity — stock change, received quantity, anomaly flag, and audit entry in one transaction — and flags any ordered-vs-received difference as an anomaly
  - [ ] 12.6 Add the Retail briefing section (current stock flags) and write pack tests: stock arithmetic, variance flagging, follow-up draft field fidelity, a receipt-retry test (submitting the same receipt twice changes stock exactly once — idempotent), a concurrent-receipt test (two receipts recorded at the same time each apply exactly once), and a no-PO follow-up test (a flagged item without a purchase order produces an owner prompt, never an invented reference)
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5 — Property 7_

- [ ] 13. Services Pack — Denana
  - [ ] 13.1 Register the pack: entities and migrations for `treatments` and `bookings` (tenant-scoped with RLS), using the pack's Playbook schema fragment defined and registered in task 2.4. Denana's final configuration (treatment list, durations, prices, hours, templates) is an explicit dated dependency: the discovery results, **due by 22 Nov 2026**. Until they land, the minimum known business shape seeded in task 2.5 is used; loading the final configuration afterwards is a configuration change, not a code change
  - [ ] 13.2 Build the public intake page (per-tenant slug, unauthenticated, may only create a booking-request task) and the workspace "simulate request" action — both create the identical task
  - [ ] 13.3 Implement the Booking agent's confirmation draft and the deterministic overlap rule: any overlap with a confirmed booking is flagged as an anomaly before the task can reach Pending Approval
  - [ ] 13.4 Wire approval outcomes: approval records the booking confirmed; rejection records the rejection and its reason
  - [ ] 13.5 Add the Services briefing section (today's confirmed bookings and pending requests) and write pack tests: overlap detection, intake equivalence, confirmation flow, and a concurrent-approval test (two approvals for the same slot raced against each other — exactly one booking may end confirmed)
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5 — Property 6_

- [ ] 14. Deployment and evaluation readiness
  - [ ] 14.1 Deploy the application to the Lightsail instance with HTTPS; activate system cron entries (routine engine, expiry sweep); verify the live app on a phone viewport
  - [ ] 14.2 Polish seed data: realistic catalogs for both tenants plus a small history of tasks and briefings
  - [ ] 14.3 Write the README runbook so a fresh clone plus the documented steps reproduces the full demo, and verify the runbook by actually reproducing the demo from a fresh clone in a clean environment; prepare evaluator credentials for the submission only (never in the repository)
  - [ ] 14.4 Run the end-to-end smoke path on a phone viewport (seed → login → Maestro command creates a task → approve a booking → briefing shows it; stock flag → follow-up draft → approval → receipt with variance) and the acceptance matrix around it: reject a task with a reason; issue a command directly in a specialist thread; rename the assistant and confirm the new name across chat, briefings, and the workspace; reopen an archived briefing; edit catalog and stock as the owner; use the per-status filter chips on the phone viewport; verify the PWA cache holds the app shell only (no tenant-private responses are cached). Fix what it surfaces
  - _Requirements: 11.1, 11.2, 11.3_

- [ ] 15. Final checkpoint — build complete
  - [ ] Ensure all tests pass and both proof applications run end to end from the live deployment. Hand over to the stage plan's polish/demo and submission stages (demo video and Devpost submission live in the stage plan, not in this task list).

---

## Coverage notes

- Every requirement R1–R11 maps to at least one task above, and every correctness property 1–10 maps to at least one task carrying a named assertion for it (groups 2, 4, 5, 6, 10, 12, 13). The mapping states where each property is asserted; it does not by itself prove the property — the assertions in the test sub-tasks are the evidence. Constraints C1–C4 are enforced by task 1.1 (fresh repository), the scope of this list (C2), tasks 6.3/6.4 (C3), and the seed data rules (C4: synthetic-only demo data, real business shapes).
- Out-of-scope items from the requirements (live channel connectors, payment execution, offline synchronisation build, voice, social media, multi-business accounts, self-serve signup, polished BYO-key UI, generative images) appear nowhere in this list by design.
- The optional MCP connector for the WhatsApp Follow-up Agent is **not** in this plan; it enters only through a requirements change on the founder's explicit instruction.
