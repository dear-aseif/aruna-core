---
inclusion: always
---

# Aruna Core — Project Structure

Workspace layout and placement rules. Verified against the task 1.2 scaffold
(commit `9df07be`, 19 Nov 2026). The spec in `.kiro/specs/aruna-core/` is the
source of truth for behavior; this file only says where things live.

## Layout (exists today)

- `src/app/` — Next.js App Router root. `layout.tsx` (root layout + metadata),
  `page.tsx` (placeholder home), `manifest.ts` (PWA manifest), `icon.svg`
  (app icon), `globals.css` (Tailwind CSS 4 via PostCSS).
- `public/` — static assets served as-is; holds `icon-maskable.svg` (PWA
  maskable icon).
- `src/components/` — shared UI library; compose from it (see `components.md`). `src/i18n/strings.ts` — the one EN/ID strings table.
- `tests/unit/` — Vitest tests (`npm test`).
- `tests/e2e/` — Playwright tests (`npm run test:e2e`). The default project
  is a phone viewport (Pixel 7): the product is mobile-first. Playwright
  starts the dev server itself on port 3100.
- `.kiro/specs/aruna-core/` — requirements.md, design.md, tasks.md.
- `.kiro/steering/` — steering files (product, tech, aruna-core, structure).
- Root config: `next.config.ts`, `tsconfig.json`, `vitest.config.ts`,
  `playwright.config.ts`, `postcss.config.mjs`, `package.json`.
- `.env.example` — the locked environment variable NAME contract
  (placeholders only). Real values live in `.env.local`, never committed.

## Placement rules

- **API-first (design rule):** all business logic lives behind the
  server/API boundary. UI components never contain business rules and never
  touch the database. Route handlers stay thin and delegate to server
  modules.
- **Server modules (planned, from task group 2):** server-only code — the
  Data Access Layer, task pipeline, model gateway, checker, approval gate —
  goes under `src/server/`, one folder per module. The Data Access Layer is
  the only path to the database (design.md).
- **Tests are required** for every task (house rule in tasks.md): unit tests
  in `tests/unit/` mirroring the module they cover, end-to-end flows in
  `tests/e2e/`.
- **Environment names are locked** by `.env.example`: `DATABASE_URL_MIGRATOR`,
  `DATABASE_URL_APP`, `DATABASE_URL_SERVICE`, `AUTH_SECRET`, `AUTH_URL`,
  `BEDROCK_REGION`, `BEDROCK_MODEL_ID`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL`.
  Do not rename or add variables without updating `.env.example` and this
  list in the same change.
- **Never commit:** `node_modules/`, `.next/`, `test-results/`,
  `tsconfig.tsbuildinfo`, `.env.local` — all covered by `.gitignore`.
- **Synthetic data only.** No real customer or business data anywhere in
  this repository, including tests and seed files.
