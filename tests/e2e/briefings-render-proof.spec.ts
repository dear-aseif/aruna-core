import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { withTenant } from "../../src/server/dal";
import { closeAllPools } from "../../src/server/db";
import { storeBriefing } from "../../src/server/briefings";
import { createBoardTenant, type BoardTenant } from "../support/board-fixtures";
import { deleteTenants } from "../support/tenant-cleanup";
// Render proof for task 10.2: Pixel 7 screenshots of the briefings list and a reopened briefing, EN then ID,
// for one synthetic tenant holding one stored briefing (today, in the business timezone).
// Opt-in so normal runs leave the repo clean:  npm run proof:render:briefings
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
test.skip(!process.env.RENDER_PROOF, "set RENDER_PROOF=1 (npm run proof:render:briefings) to regenerate docs/render-proof/10.2");
const OUT = "docs/render-proof/10.2";
const run = randomBytes(4).toString("hex");
let T: BoardTenant;
test.beforeAll(async () => {
  T = await createBoardTenant("briefproof", run);
  // The Denana Playbook's business timezone; the list treats the briefing for this local date as "today".
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - 86_400_000));
  const [doneId, rejectedId, pendingId] = [randomUUID(), randomUUID(), randomUUID()];
  await withTenant(T.agent, (tx) =>
    storeBriefing(tx, {
      scheduleDate: today,
      sections: [
        {
          id: "core.yesterday_outcomes",
          facts: {
            date: yesterday,
            done: 1,
            rejected: 1,
            expired: 0,
            tasks: [
              { id: doneId, title: "Confirm booking for synthetic client A", status: "done" },
              { id: rejectedId, title: "Reminder draft for synthetic client B", status: "rejected" },
            ],
          },
        },
        {
          id: "core.pending_approvals",
          facts: { count: 1, tasks: [{ id: pendingId, title: "Follow-up message for synthetic client C" }] },
        },
      ],
    }),
  );
});
test.afterAll(async () => {
  await deleteTenants([T.tenantId]);
  await closeAllPools();
});
test("briefings list and detail on a phone, EN then ID", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(T.email);
  await page.getByLabel("Password").fill(T.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/board$/);
  await page.goto("/briefings");
  await expect(page.getByTestId("briefing-today")).toBeVisible();
  await page.screenshot({ path: `${OUT}/briefings-en.png`, fullPage: true });
  await page.getByTestId("briefing-today").getByRole("link").click();
  await expect(page.getByTestId("briefing-detail")).toBeVisible();
  await expect(page.getByTestId("briefing-section")).toHaveCount(2);
  await page.screenshot({ path: `${OUT}/briefing-detail-en.png`, fullPage: true });
  await page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" }).click();
  await expect(page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/briefings");
  await expect(page.getByTestId("briefing-today")).toBeVisible();
  await page.screenshot({ path: `${OUT}/briefings-id.png`, fullPage: true });
  await page.getByTestId("briefing-today").getByRole("link").click();
  await expect(page.getByTestId("briefing-detail")).toBeVisible();
  await expect(page.getByTestId("briefing-section")).toHaveCount(2);
  await page.screenshot({ path: `${OUT}/briefing-detail-id.png`, fullPage: true });
});
