import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { closeAllPools } from "../../src/server/db";
import { createBoardTask, createBoardTenant, type BoardTenant } from "../support/board-fixtures";
import { deferTenantCleanup } from "../support/ledger";
// Render proof for task 9.3: Pixel 7 screenshots of a task detail, EN then ID, for one synthetic tenant.
// Opt-in so normal runs leave the repo clean:  npm run proof:render:detail
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
test.skip(!process.env.RENDER_PROOF, "set RENDER_PROOF=1 (npm run proof:render:detail) to regenerate docs/render-proof/9.3");
const OUT = "docs/render-proof/9.3";
const run = randomBytes(4).toString("hex");
let T: BoardTenant;
test.beforeAll(async () => {
  T = await createBoardTenant("proof93", run);
});
test.afterAll(async () => {
  deferTenantCleanup([T.tenantId]);
  await closeAllPools();
});
test("task detail on a phone, EN then ID", async ({ page }) => {
  const id = await createBoardTask(T, "Konfirmasi booking Facial Dasar", "pending_approval", { customer: "Contoh Pelanggan", treatment: "Facial Dasar", slot: "Sel 24 Nov, 10:00" });
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(T.email);
  await page.getByLabel("Password").fill(T.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/board$/);
  await page.locator(`[data-task-id="${id}"]`).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("column-pending_approval").locator(`[data-task-id="${id}"]`)).toHaveCount(0, { timeout: 20_000 });
  await page.goto(`/board/${id}`);
  await expect(page.getByTestId("audit-entry").first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/detail-en.png`, fullPage: true });
  await page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" }).click();
  await expect(page.getByText("Jejak audit")).toBeVisible();
  await page.screenshot({ path: `${OUT}/detail-id.png`, fullPage: true });
});
