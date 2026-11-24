# Aruna Core — Component Library & UI Conventions

Shared UI lives in `src/components/`. **Future UI tasks (9.2, 9.3, 9.4 and later) MUST compose from this
library and extend it; they must not re-implement these pieces inline.** A new reusable piece is added
here and listed below in the same change. Task card variants joined in 9.2 and the history/detail views in 9.3 (see below).

## Rules

1. **Strings:** every UI string comes from the one table `src/i18n/strings.ts` (EN and ID, same keys,
   no empty values). Read them with `useT()` (client) or `translate()` (server). No literal UI text in
   components, layouts or pages. Adding a key means adding it in both languages.
2. **Language:** per-tenant `settings.ui_language` (default `en`), changed only via
   `POST /api/workspace/language` (server operation `setShellLanguage`).
3. **Tokens:** colours, spacing and font sizes are defined once in `src/app/globals.css` `@theme`.
   Use token utilities (`bg-primary`, `text-ink-muted`, `p-gutter`, `text-body`, `rounded-control`).
   No raw palette classes (`slate-*`, `indigo-*`), `bg-white`, `text-xs/sm/xl`, arbitrary `[...]`
   values or hex literals in `src/`. Enforced by `tests/unit/design-tokens.test.ts`.
4. **Business logic stays out of components** (API-first); components render what the server sends.

## Catalogue (task 9.1)

| Component | File | Purpose |
|---|---|---|
| `WorkspaceShell` | `workspace-shell.tsx` | Composes the shell: side rail (md+), phone header, bottom nav; provides the language. |
| `BusinessHeader` | `business-header.tsx` | Business name + assistant name. `variant="rail"` or `"bar"` (phone header, optional `action` slot). |
| `NavItem` | `nav-item.tsx` | One nav link. `variant="rail"` or `"tab"`; sets `aria-current`. |
| `BottomNav` | `bottom-nav.tsx` | Phone tab bar built from `NavItem`s. |
| `Button` | `button.tsx` | `variant="primary"` or `"outline"`; `size="md"` or `"sm"`. |
| `LanguageToggle` | `language-toggle.tsx` | EN \| ID switch; saves via the server, then refreshes. |
| `I18nProvider`, `useT` | `i18n-provider.tsx` | Client access to the tenant's language and the strings table. |
| `ScreenPlaceholder` | `screen-placeholder.tsx` | Placeholder body for screens built in later tasks. |

## Catalogue (task 9.2, task board)

| Component | File | Purpose |
|---|---|---|
| `TaskBoard` | `task-board.tsx` | The board: columns per status from md up, one status at a time with chips on phones; chat and briefing quick actions; shows action errors. |
| `BoardColumn` | `board-column.tsx` | One status column (`data-testid="column-<status>"`); hidden on phones unless selected. |
| `StatusFilterChips` | `status-filter-chips.tsx` | Phone-only status chips with counts (`md:hidden`). |
| `StatusBadge` | `status-badge.tsx` | Localized status label; `statusLabelKey` maps a status to its string key. |
| `TaskCard` | `task-card.tsx` | Default card variant: title, status, agent, Pending Approval deadline and checked draft, recorded error. `actions` slot. |
| `ApprovalTaskCard` | `approval-task-card.tsx` | Pending Approval variant: Approve, Reject, Edit draft (revise) buttons calling the task API routes. |
| `ButtonLink` | `button-link.tsx` | A link styled as a `Button`; `buttonClass()` in `button.tsx` is the shared styling. |

Server side: `src/server/board/` (`loadBoard`, `approveFromBoard`, `rejectFromBoard`, `reviseFromBoard`); routes under `src/app/api/workspace/board` and `.../tasks/[id]/{approve,reject,revise}`.

A revise re-checks the edited draft (`checkTaskWithReview`) and routes onward in the same request: the task goes to Pending Approval at the new revision if the checks pass, or to Working with the anomaly recorded if they fail. It does not simply return the task to In Review.

## Catalogue (task 9.3, task cards and detail)

| Component | File | Purpose |
|---|---|---|
| `TaskHistorySummary` | `task-history-summary.tsx` | Check results and approval decisions of one task, oldest first, times in the business timezone. Used on `TaskCard` and the detail. |
| `AuditTrail` | `audit-trail.tsx` | Read-only list of a task's audit entries, oldest first (type label, time, actor, scalar facts). |
| `TaskDetailView` | `task-detail-view.tsx` | The task detail page body: agent, origin, status, draft, history, audit trail. |

`TaskCard` now also shows the origin (routine, maestro, direct, intake), the history summary, and an "Open details" link to `/board/<id>`.

Server side: `loadTaskDetail` in `src/server/board/service.ts` (uses the 4.4 detail operation), pure mapping in `src/server/board/history.ts` (`formatTimestamp` renders UTC instants in the Playbook timezone); route `GET /api/workspace/tasks/[id]`; page `src/app/(workspace)/board/[id]/page.tsx`. Another tenant's task is a 404. Render proof: `npm run proof:render:detail` writes `docs/render-proof/9.3/`.

## Catalogue (task 9.4, chat, briefings, settings)

| Component | File | Purpose |
|---|---|---|
| `ChatView` | `chat-view.tsx` | Chat screen: thread tabs, message list (or empty state), composer. |
| `ThreadTabs` | `thread-tabs.tsx` | One link per thread (Maestro first), `?thread=<id>`; names come from the server. |
| `MessageBubble` | `message-bubble.tsx` | One message; agent sender name is live; a command links to its task. |
| `ChatComposer` | `chat-composer.tsx` | Message box; posts to `/api/workspace/chat/messages`, shows the outcome. |
| `BriefingsView` | `briefings-view.tsx` | Today + archive; honest empty states (no sample content). |
| `SettingsView` | `settings-view.tsx` | Settings screen composing the four blocks below. |
| `SettingsSection` | `settings-section.tsx` | Titled block used by every settings panel. |
| `AssistantNameForm` | `assistant-name-form.tsx` | Rename the assistant (server validates and audits). |
| `PlaybookPanel` | `playbook-panel.tsx` | Read-only Playbook view. |
| `ModelConfigPanel` | `model-config-panel.tsx` | Read-only model configuration. |
| `ExportPanel` | `export-panel.tsx` | Owner export trigger. Calls `POST /api/workspace/settings/export`, shows the cutoff and total record count (from response headers), and offers the returned zip as a download link (`export-download`). Disabled only if no runner is installed. |

Server side: `src/server/chat/` (`routeChatMessage` is the one routing rule: a recognized Maestro-thread question goes to `askMaestro`, everything else to `submitCommand`; `loadChat`, `sendChatMessage`), `src/server/settings/owner.ts` (`loadSettings`, `renameAssistantForOwner`; `renameAssistant` in `settings/index.ts` audits `settings.assistant_name_changed`), `src/server/exports/` (owner-only trigger `requestOwnExport`; real service since 10.3: `service.ts` runs one explicit-column SQL statement in the owner's tenant session, `registry.ts` lists the exported entities and is where packs register theirs with `registerExportEntity`, `archive.ts` builds the zip and CSV), `src/server/briefings/` (`loadBriefings`; real since 10.2), `src/server/workspace/owner-errors.ts` (HTTP mapping). Render proof: `npm run proof:render:chat` writes `docs/render-proof/9.4/`.

## Catalogue (task 10.2, briefings)

| Component | File | Purpose |
|---|---|---|
| `BriefingsView` | `briefings-view.tsx` | Today + archive; each row has an "Open briefing" `ButtonLink` to `/briefings/<id>`. Honest empty states. |
| `BriefingDetailView` | `briefing-detail-view.tsx` | Briefing Detail: date, live-named greeting, generated time, sections (summary + items, task items link to `/board/<id>`). Read only. |

Server side: `src/server/briefings/` (`store.ts`: `storeBriefing` idempotent per (tenant, date), `installBriefingArchive` wires the routine sink; `render.ts`: deterministic templates, `registerSectionRenderer` is where pack sections (12.6, 13.5) plug in; `index.ts`: `loadBriefings`, `loadBriefingDetail`); route `GET /api/workspace/briefings/[id]`; page `src/app/(workspace)/briefings/[id]/page.tsx`. The table stores facts only; text and the assistant name are produced on read.

## Render proof

Phone-viewport screenshots per UI task go in `docs/render-proof/<task>/` (EN and ID), generated by a
Playwright spec (task 9.1: `npm run proof:render`).
